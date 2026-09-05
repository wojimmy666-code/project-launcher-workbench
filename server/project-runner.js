const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { ROOT_DIR, resolveLogFile } = require("./config");
const {
  partitionProjectListeningInstances,
  resolveProjectPort,
  resolveProjectPorts
} = require("./project-port");
const {
  classifyProjectPids,
  findPortPids,
  findProjectListeningInstances,
  findProjectPids,
  getProcessIdentity,
  getProcessMemoryInfo,
  getWindowsProcessesAsync,
  invalidateProcessSnapshot,
  isPortOpen,
  processIdentityMatches
} = require("./status-checker");
const {
  describeProcessExit,
  isControlInterrupt,
  normalizeProcessExitCode
} = require("./process-exit");

const RUNNABLE_TYPES = new Set(["exe", "bat", "cmd"]);
const OPENABLE_TYPES = new Set(["url", "folder", "file"]);
const RUNTIME_STATE_PATH = path.join(ROOT_DIR, "config", "runtime-state.json");
const WINDOWS_FOLDER_OPENER_PATH = path.join(ROOT_DIR, "scripts", "open-folder.ps1");
const WINDOWS_MANAGED_PROCESS_HOST_PATH = path.join(ROOT_DIR, "scripts", "managed-process-host.ps1");
const CODEX_DESKTOP_OPENER_PATH = path.join(ROOT_DIR, "scripts", "open-codex-app.ps1");
const CODEX_DIAGNOSTIC_OPENER_PATH = path.join(ROOT_DIR, "scripts", "open-codex-diagnosis.ps1");
const STOP_SETTLE_TIMEOUT_MS = 5000;
const STOP_SETTLE_POLL_INTERVAL_MS = 100;
const TASKKILL_EXIT_TIMEOUT_MS = 1500;
const SERVICE_CAPTURE_WINDOW_MS = 60 * 1000;
const PROCESS_START_GRACE_MS = 5000;
const STARTUP_POLL_INTERVAL_MS = 250;
const PROCESS_START_CONFIRM_MS = 1500;
const PROCESS_LINEAGE_START_TOLERANCE_MS = 2000;
const MANAGED_PROCESS_CAPTURE_DELAYS_MS = [100, 500, 1500, 3000, 8000, 15000];
const PROTECTED_PROCESS_NAMES = new Set([
  "system",
  "system idle process",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "services.exe",
  "lsass.exe",
  "winlogon.exe"
]);
let codexDesktopLaunchPending = null;

class ProjectRunner {
  constructor(options = {}) {
    this.processes = new Map();
    this.runtimeStatePath = options.runtimeStatePath || RUNTIME_STATE_PATH;
    this.spawnProcess = options.spawnProcess || spawn;
    this.externalControlRunner = options.externalControlRunner || runExternalControlProcess;
    if (options.loadRuntimeState !== false) {
      this.loadRuntimeState();
    }
  }

  hasExternalControlAction(project, action) {
    return Array.isArray(project?.externalControl?.actions?.[action])
      && project.externalControl.actions[action].length > 0;
  }

  async runExternalControlAction(project, action, context = {}) {
    if (!this.hasExternalControlAction(project, action)) return { configured: false };
    const result = await this.externalControlRunner(project, action, context);
    await this.appendLog(project, `[${now()}] external control action completed: ${action}\n`);
    return { configured: true, ...result };
  }

  getRuntimeState(projectId, options = {}) {
    const states = this.getProcessStates(projectId, options);
    if (!states.length) return null;

    const runningStates = states.filter((state) => state.running);
    const readyStates = runningStates.filter((state) => !state.starting && !state.stopping && !state.lastError);
    const stopping = states.some((state) => state.stopping);
    const starting = states.some((state) => state.starting);
    const latest = states.reduce((current, state) => (
      !current || state.startedAt > current.startedAt ? state : current
    ), null);
    const primary = runningStates[0] || latest;
    const rootPids = [...new Set(runningStates.flatMap((state) => this.getLiveStatePids(state, options)))];
    // Descendants are captured and identity-checked before being persisted.
    // Do not rediscover descendants while rendering runtime state: a stale
    // ParentProcessId can point at a reused PID and pull unrelated processes in.
    const trackedPids = rootPids;
    const primaryPid = this.getLiveStatePids(primary, options)[0] || getStatePid(primary);
    const servicePids = [...new Set(runningStates.flatMap((state) => (
      normalizePidList(state.servicePids).filter((pid) => rootPids.includes(pid))
    )))];

    return {
      projectId,
      pid: primaryPid,
      pids: trackedPids,
      rootPids,
      servicePids,
      processCount: states.length,
      runningCount: runningStates.length,
      readyCount: readyStates.length,
      running: runningStates.length > 0,
      starting,
      stopping,
      source: primary?.source || "managed",
      adoptedAt: primary?.adoptedAt || null,
      startedAt: latest?.startedAt || null,
      exitedAt: latest?.exitedAt || null,
      exitCode: latest?.exitCode,
      signal: latest?.signal || null,
      lastError: latest?.lastError || null,
      stoppedByUser: Boolean(latest?.stoppedByUser),
      processSanitization: latest?.lastProcessSanitization || null,
      instances: runningStates.map((state) => {
        const livePids = this.getLiveStatePids(state, options);
        return {
          instanceId: state.instanceId || null,
          pid: livePids[0] || getStatePid(state),
          pids: livePids,
          servicePids: normalizePidList(state.servicePids).filter((pid) => livePids.includes(pid)),
          source: state.source || "managed",
          startedAt: state.startedAt || null,
          adoptedAt: state.adoptedAt || null,
          starting: Boolean(state.starting),
          stopping: Boolean(state.stopping)
        };
      })
    };
  }

  getProcessStates(projectId, options = {}) {
    const states = this.processes.get(projectId);
    if (!states) return [];

    const list = Array.isArray(states) ? states : [states];
    let changed = false;
    const nowMs = Date.now();
    for (const state of list) {
      const alive = this.isStateAlive(state, options);
      if (state.running && !alive) {
        const launchStillSettling = !state.stoppedByUser
          && nowMs - Number(state.startedAt || 0) <= PROCESS_START_GRACE_MS
          && (!state.child || state.child.exitCode == null);
        if (launchStillSettling) continue;

        state.running = false;
        state.exitedAt = state.exitedAt || Date.now();
        state.exitCode = state.exitCode ?? null;
        state.child = null;
        changed = true;
      } else if (!state.running && !state.stoppedByUser && alive) {
        // Windows can briefly report a newly spawned process as unavailable.
        // A matching PID identity is strong enough to recover that instance.
        state.running = true;
        state.exitedAt = null;
        state.exitCode = null;
        state.signal = null;
        changed = true;
      }
    }

    const compacted = compactProcessStates(list);
    if (compacted.length !== list.length) {
      changed = true;
    }
    this.processes.set(projectId, compacted);

    if (changed) {
      this.saveRuntimeState();
    }

    return compacted;
  }

  compactProcessStates(projectId) {
    const states = this.processes.get(projectId);
    const compacted = compactProcessStates(states);
    if (compacted.length) {
      this.processes.set(projectId, compacted);
    } else {
      this.processes.delete(projectId);
    }
    return compacted;
  }

  getRunningStates(projectId, options = {}) {
    return this.getProcessStates(projectId, options).filter((state) => state.running);
  }

  clearInactiveRuntimeState(projectId, options = {}) {
    const states = this.getProcessStates(projectId, options);
    if (!states.length || states.some((state) => state.running)) return false;
    this.processes.delete(projectId);
    this.saveRuntimeState();
    return true;
  }

  getTrackedProcessTreePids(rootPids, options = {}) {
    return getTrackedProcessTreePids(rootPids, options);
  }

  getIndependentProcessRoots(pids, options = {}) {
    return getIndependentProcessRoots(pids, options);
  }

  getProcessIdentity(pid, options) {
    return getProcessIdentity(pid, options);
  }

  isPidAlive(pid) {
    return isPidAlive(pid);
  }

  getProcessMemoryInfo(pids, options) {
    return getProcessMemoryInfo(pids, options);
  }

  getWindowsProcessesAsync(options) {
    return getWindowsProcessesAsync(options);
  }

  captureStateProcessTree(state, options = {}) {
    if (!state || state.stoppedByUser) return false;

    const rootPid = getStatePid(state);
    // A status request can observe the pending state while appendLog() is still
    // awaiting I/O and before spawn() assigns the launch PID. Do not turn that
    // short-lived pending state into a strict, identity-required state: doing
    // so would make the startup confirmer wait for the slow process snapshot.
    if (!rootPid && state.starting) return false;

    const identitiesByPid = new Map(
      normalizeProcessIdentities(state.processIdentities)
        .map((identity) => [identity.pid, identity])
    );
    const identityOptions = Array.isArray(options.processes)
      ? { processes: options.processes }
      : { fresh: Boolean(options.fresh) };
    const rootAlive = Boolean(rootPid && this.isTrackedPidAlive(rootPid, state, identityOptions));
    const withinCaptureWindow = Date.now() - Number(state.startedAt || 0) <= SERVICE_CAPTURE_WINDOW_MS;
    const existingServicePids = normalizePidList(state.servicePids);
    const startedAt = Number(state.startedAt || 0);
    const verifiedServiceRoots = state.lineageVerified
      ? existingServicePids.filter((pid) => {
        const identity = identitiesByPid.get(pid);
        return identity
          && (!startedAt || Number(identity.createdAt || 0) + PROCESS_LINEAGE_START_TOLERANCE_MS >= startedAt)
          && this.isTrackedPidAlive(pid, state, identityOptions);
      })
      : [];

    // Prefer the original launch PID. If a short-lived BAT/CMD shell has
    // already exited, its captured and identity-verified services become the
    // roots. Version-2 state is intentionally not trusted without a live root.
    const authoritativeRoot = Boolean(rootPid && (rootAlive || withinCaptureWindow));
    const roots = authoritativeRoot ? [rootPid] : verifiedServiceRoots;
    const rootIdentities = roots
      .map((pid) => identitiesByPid.get(pid))
      .filter(Boolean);

    const memory = roots.length
      ? this.getProcessMemoryInfo(roots, {
        trackHistory: false,
        fresh: Boolean(options.fresh),
        processes: Array.isArray(options.processes) ? options.processes : undefined,
        rootIdentities
      })
      : { pids: [], rejectedEdgeCount: 0 };
    const discoveredPids = normalizePidList(memory?.pids);
    // A freshly-created Windows process can be alive before it appears in the
    // WMI snapshot used by getProcessMemoryInfo(). Treat that empty snapshot as
    // inconclusive while startup capture is still in progress. Otherwise the
    // state becomes identityRequired without an identity and can never recover,
    // producing a false "launcher exited (unknown)" result for a live process.
    if (
      withinCaptureWindow
      && !state.launcherExitObserved
      && !state.exitedAt
      && !discoveredPids.length
      && !verifiedServiceRoots.length
    ) {
      return false;
    }
    const nextServicePids = discoveredPids.filter((pid) => pid !== rootPid);
    const nextTrackedPids = [...new Set([
      ...(rootAlive ? [rootPid] : []),
      ...nextServicePids
    ])];
    const nextIdentities = nextTrackedPids
      .map((pid) => this.getProcessIdentity(pid, identityOptions))
      .filter(Boolean);
    const removedPids = existingServicePids.filter((pid) => !nextServicePids.includes(pid));
    const rejectedEdgeCount = Number(memory?.rejectedEdgeCount || 0);
    const previousSnapshot = JSON.stringify({
      servicePids: existingServicePids,
      processIdentities: normalizeProcessIdentities(state.processIdentities),
      running: Boolean(state.running),
      stopping: Boolean(state.stopping),
      lineageVerified: Boolean(state.lineageVerified)
    });

    if (removedPids.length) {
      state.lastProcessSanitization = {
        at: Date.now(),
        removedProcessCount: removedPids.length,
        rejectedEdgeCount
      };
      if (Array.isArray(options.sanitizationReports)) {
        options.sanitizationReports.push({
          instanceId: state.instanceId || null,
          removedPids,
          rejectedEdgeCount
        });
      }
    }

    state.servicePids = nextServicePids;
    state.processIdentities = nextIdentities;
    state.identityRequired = true;
    state.lineageVerified = Boolean(state.lineageVerified || (authoritativeRoot && discoveredPids.length));
    state.running = nextTrackedPids.length > 0;
    if (state.running) {
      state.exitedAt = null;
      state.exitCode = null;
      state.signal = null;
    } else {
      state.exitedAt = state.exitedAt || Date.now();
    }
    if (state.stopping && !state.running) {
      state.stopping = false;
    }

    const nextSnapshot = JSON.stringify({
      servicePids: state.servicePids,
      processIdentities: state.processIdentities,
      running: Boolean(state.running),
      stopping: Boolean(state.stopping),
      lineageVerified: Boolean(state.lineageVerified)
    });
    return previousSnapshot !== nextSnapshot || removedPids.length > 0;
  }

  captureManagedProcessTrees(projectId, options = {}) {
    const stored = this.processes.get(projectId);
    if (!stored) return false;

    const states = Array.isArray(stored) ? stored : [stored];
    const nowMs = Date.now();
    let changed = false;
    for (const state of states) {
      const eligible = !state.stoppedByUser
        && (state.running || nowMs - Number(state.startedAt || 0) <= SERVICE_CAPTURE_WINDOW_MS);
      if (eligible && this.captureStateProcessTree(state, options)) {
        changed = true;
      }
    }

    if (changed) {
      this.processes.set(projectId, compactProcessStates(states));
      invalidateProcessSnapshot();
      this.saveRuntimeState();
    }
    return changed;
  }

  reconcileProjectProcesses(project, options = {}) {
    if (!project?.id) return false;
    return this.captureManagedProcessTrees(project.id, options);
  }

  scheduleManagedProcessCapture(projectId, state) {
    for (const captureDelay of MANAGED_PROCESS_CAPTURE_DELAYS_MS) {
      const timer = setTimeout(async () => {
        const stored = this.processes.get(projectId);
        const states = Array.isArray(stored) ? stored : (stored ? [stored] : []);
        if (!states.includes(state) || state.stoppedByUser) return;
        try {
          const processes = await this.getWindowsProcessesAsync({ fresh: true });
          if (!processes.length || !states.includes(state) || state.stoppedByUser) return;
          if (this.captureStateProcessTree(state, { processes })) {
            this.processes.set(projectId, compactProcessStates(states));
            this.saveRuntimeState();
          }
        } catch {}
      }, captureDelay);
      timer.unref?.();
    }
  }

  getStateTrackedPids(state) {
    return [...new Set([
      getStatePid(state),
      ...normalizePidList(state?.servicePids)
    ].filter(Boolean))];
  }

  isTrackedPidAlive(pid, state, options = {}) {
    if (!this.isPidAlive(pid)) return false;
    const expected = normalizeProcessIdentities(state?.processIdentities)
      .find((identity) => identity.pid === Number(pid));
    if (!expected) return !state?.identityRequired;
    return processIdentityMatches(expected, this.getProcessIdentity(pid, options));
  }

  getLiveStatePids(state, options = {}) {
    return this.getStateTrackedPids(state).filter((pid) => this.isTrackedPidAlive(pid, state, options));
  }

  isStateAlive(state, options = {}) {
    return this.getLiveStatePids(state, options).length > 0;
  }

  isPersistedStateAlive(state) {
    const strictState = { ...state, identityRequired: true };
    const pids = this.getStateTrackedPids(strictState);
    return pids.some((pid) => this.isTrackedPidAlive(pid, strictState));
  }

  async killProcessTree(pid, options = {}) {
    const processes = Array.isArray(options.processes)
      ? options.processes
      : await this.getWindowsProcessesAsync();
    assertSafeProcessTreeTargets([pid], processes);
    return killProcessTree(pid);
  }

  spawnIndependentProcess(command, args, options) {
    return spawnIndependentProcess(command, args, options, this.spawnProcess);
  }

  spawnManagedProcessHost(command, args, options) {
    return spawnManagedProcessHost(command, args, options, this.spawnProcess);
  }

  openProjectOutput(project, options = {}) {
    const runContext = options.runContext;
    if (runContext?.stdoutPath && runContext?.stderrPath) {
      fs.mkdirSync(path.dirname(runContext.stdoutPath), { recursive: true });
      fs.mkdirSync(path.dirname(runContext.stderrPath), { recursive: true });
      const stdoutFd = fs.openSync(runContext.stdoutPath, "a");
      const stderrFd = fs.openSync(runContext.stderrPath, "a");
      let closed = false;
      return {
        stdoutPath: runContext.stdoutPath,
        stderrPath: runContext.stderrPath,
        stdio: ["ignore", stdoutFd, stderrFd],
        close() {
          if (closed) return;
          closed = true;
          fs.closeSync(stdoutFd);
          fs.closeSync(stderrFd);
        }
      };
    }

    const file = resolveLogFile(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a");
    let closed = false;
    return {
      stdoutPath: file,
      stderrPath: file,
      stdio: ["ignore", fd, fd],
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      }
    };
  }

  launchProjectProcess(project, launch, instanceId, options = {}) {
    const output = this.openProjectOutput(project, options);
    const env = createProjectEnvironment(project, process.env, instanceId, options.runContext);
    try {
      if (shouldUseWindowsManagedProcessHost(project, launch)) {
        const plan = createWindowsManagedProcessPlan(launch, output);
        return this.spawnManagedProcessHost(resolveWindowsExecutablePath("powershell.exe"), [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          WINDOWS_MANAGED_PROCESS_HOST_PATH,
          "-PlanBase64",
          Buffer.from(JSON.stringify(plan), "utf8").toString("base64")
        ], {
          cwd: launch.cwd,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
          env
        });
      }

      return this.spawnIndependentProcess(launch.command, launch.args, {
        cwd: launch.cwd,
        shell: false,
        stdio: output.stdio,
        windowsHide: Boolean(launch.windowsHide),
        windowsVerbatimArguments: Boolean(launch.windowsVerbatimArguments),
        env
      });
    } finally {
      output.close();
    }
  }

  findProjectPids(project, options) {
    return findProjectPids(project, options);
  }

  findPortPids(port) {
    return findPortPids(port);
  }

  findProjectListeningInstances(project, options) {
    return findProjectListeningInstances(project, options);
  }

  classifyProjectPids(project, pids, options) {
    return classifyProjectPids(project, pids, options);
  }

  isPortOpen(host, port) {
    return isPortOpen(host, port);
  }

  async confirmProjectStartup(project, state, options = {}) {
    throwIfStartupCancelled(options.signal);
    const timeoutMs = Number(project.startupTimeoutMs || 0);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      state.starting = false;
      return { confirmed: false, ports: [] };
    }

    const ports = resolveProjectPorts(project);
    const launchMode = project.launchMode === "detached" ? "detached" : "foreground";
    const pollIntervalMs = Math.max(10, Number(options.startupPollIntervalMs || STARTUP_POLL_INTERVAL_MS));
    const processConfirmMs = Math.max(0, Number(options.processStartupConfirmMs ?? PROCESS_START_CONFIRM_MS));
    const wait = options.delay || delay;
    const deadline = Date.now() + timeoutMs;
    const host = project.host || "127.0.0.1";
    let ownershipStageReported = false;

    reportStage(
      options,
      ports.length ? "waiting_ports" : "waiting_process",
      ports.length
        ? `等待端口 ${ports.join("、")} 就绪`
        : "等待项目进程稳定运行",
      { ports }
    );

    state.starting = true;
    this.saveRuntimeState();

    while (true) {
      throwIfStartupCancelled(options.signal);
      let livePids = this.getLiveStatePids(state);

      if (ports.length) {
        let allReady = true;
        for (const port of ports) {
          if (!await this.isPortOpen(host, port)) {
            allReady = false;
            break;
          }
        }

        let processes = null;
        if (allReady) {
          if (!ownershipStageReported) {
            ownershipStageReported = true;
            reportStage(options, "verifying_ownership", "端口已响应，正在核验监听进程归属", { ports });
          }
          processes = await this.getWindowsProcessesAsync({ fresh: true });
          if (processes.length) {
            this.captureStateProcessTree(state, { processes });
            livePids = this.getLiveStatePids(state, { processes });
          }
        }

        for (const port of allReady ? ports : []) {
          const portPids = await this.findPortPids(port);
          const ownership = this.classifyProjectPids(project, portPids, {
            runtimePids: new Set(livePids),
            knownProjects: options.projects,
            processes: processes || undefined,
            fresh: !processes
          });
          if (ownership.foreignPids.length) {
            if (Date.now() - Number(state.startedAt || 0) < PROCESS_LINEAGE_START_TOLERANCE_MS) {
              allReady = false;
              break;
            }
            const owner = ownership.conflicts[0];
            const ownerText = owner?.ownerProjectName || owner?.name || "其他进程";
            const pidText = owner?.pid ? `（PID ${owner.pid}）` : "";
            throw createStartupError(
              "PROJECT_STARTUP_PORT_CONFLICT",
              `启动过程中端口 ${port} 被 ${ownerText}${pidText}占用`
            );
          }
          if (!portPids.length || !ownership.ownedPids.length) {
            allReady = false;
            break;
          }
        }

        if (allReady) {
          state.starting = false;
          state.startupConfirmedAt = Date.now();
          state.lastError = null;
          this.saveRuntimeState();
          return { confirmed: true, ports };
        }
      } else if (livePids.length && Date.now() - Number(state.startedAt || 0) >= processConfirmMs) {
        state.starting = false;
        state.startupConfirmedAt = Date.now();
        state.lastError = null;
        this.saveRuntimeState();
        return { confirmed: true, ports: [] };
      }

      // exitedAt can also be populated by process-tree reconciliation. Only an
      // observed ChildProcess exit (or a concrete exit status/signal) proves
      // that the foreground launcher actually terminated.
      const launcherExited = Boolean(
        state.launcherExitObserved || state.exitCode !== null || state.signal
      );
      const launcherExitCode = normalizeProcessExitCode(state.exitCode, state.signal);
      const launcherInterrupted = isControlInterrupt(launcherExitCode, state.signal);
      if (launcherExited && launchMode === "foreground" && !livePids.length) {
        throw createStartupError(
          launcherInterrupted ? "PROJECT_STARTUP_INTERRUPTED" : "PROJECT_STARTUP_EXITED",
          launcherInterrupted
            ? `${describeProcessExit(launcherExitCode, state.signal)}，项目没有进入运行状态`
            : `启动脚本已结束（${describeProcessExit(launcherExitCode, state.signal)}），但项目没有进入运行状态`,
          { exitCode: launcherExitCode, signal: state.signal || null }
        );
      }
      if (launcherExited && launcherExitCode !== null && launcherExitCode !== 0 && !livePids.length) {
        throw createStartupError(
          launcherInterrupted ? "PROJECT_STARTUP_INTERRUPTED" : "PROJECT_STARTUP_EXITED",
          launcherInterrupted
            ? describeProcessExit(launcherExitCode, state.signal)
            : `启动脚本异常退出，${describeProcessExit(launcherExitCode, state.signal)}`,
          { exitCode: launcherExitCode, signal: state.signal || null }
        );
      }
      if (Date.now() >= deadline) {
        const targetText = ports.length ? `端口 ${ports.join("、")}` : "项目进程";
        throw createStartupError(
          "PROJECT_STARTUP_TIMEOUT",
          `启动确认超时：${timeoutMs} 毫秒内未检测到${targetText}就绪`
        );
      }
      await waitWithSignal(pollIntervalMs, options.signal, wait);
    }
  }

  async startProject(project, options = {}) {
    reportStage(options, "validating", "正在校验项目配置");
    throwIfStartupCancelled(options.signal);
    this.assertProjectShape(project);

    const runningStates = this.getRunningStates(project.id);
    const trackedPids = new Set(this.getTrackedProcessTreePids(
      runningStates.flatMap((state) => this.getLiveStatePids(state))
    ));
    let portState = null;
    if (RUNNABLE_TYPES.has(project.type)) {
      reportStage(options, "checking_ports", "正在检查目标端口和现有实例", {
        ports: resolveProjectPorts(project)
      });
      portState = await this.findPortConflicts(project, trackedPids, options);
      const blockingPort = portState.portStates.find((state) => (
        state.conflictPids.length || state.unverified
      ));
      if (blockingPort) {
        const owner = blockingPort.conflicts[0];
        const ownerText = owner?.ownerProjectName || owner?.name || "未知进程";
        const pidText = owner?.pid ? `（PID ${owner.pid}）` : "";
        const portRole = blockingPort.port === portState.port ? "主端口" : "辅助端口";
        const error = new Error(
          `${portRole} ${blockingPort.port} 已被 ${ownerText}${pidText}占用，无法启动`
        );
        error.statusCode = 409;
        error.code = "PROJECT_PORT_CONFLICT";
        error.details = {
          code: error.code,
          port: blockingPort.port,
          portRole,
          pids: blockingPort.portPids,
          conflicts: blockingPort.conflicts,
          unverified: blockingPort.unverified
        };
        throw error;
      }
    }

    if (!project.allowMultiple) {
      if (runningStates.length) {
        return {
          ok: true,
          alreadyRunning: true,
          message: "\u9879\u76ee\u5df2\u7531\u5de5\u4f5c\u53f0\u542f\u52a8",
          runtime: this.getRuntimeState(project.id)
        };
      }

      const projectPort = resolveProjectPort(project);
      if (Number.isInteger(projectPort)) {
        const targetPids = normalizePidList(portState?.ownedPids);
        if (targetPids.length) {
          await this.appendLog(project, "[" + now() + "] start skipped: target listener pid(s) "
            + targetPids.join(", ") + ", port=" + projectPort + "\n");
          return {
            ok: true,
            alreadyRunning: true,
            external: true,
            externalPids: targetPids,
            message: "检测到项目已在目标端口 " + projectPort + " 运行",
            runtime: this.getRuntimeState(project.id)
          };
        }

        const listeningInstances = await this.findProjectListeningInstances(project, {
          runtimePids: new Set(),
          fresh: true
        });
        const {
          targetInstances: targetListeningInstances,
          alternateInstances
        } = partitionProjectListeningInstances(project, listeningInstances);
        if (targetListeningInstances.length) {
          const error = new Error(
            "无法启动：项目进程已监听目标端口 " + projectPort + "，但该端口当前不可访问"
          );
          error.statusCode = 409;
          error.code = "PROJECT_TARGET_LISTENER_UNREACHABLE";
          error.details = {
            code: error.code,
            targetPort: projectPort,
            instances: targetListeningInstances
          };
          throw error;
        }
        if (alternateInstances.length) {
          const ports = [...new Set(alternateInstances.flatMap(getListeningInstancePorts))]
            .sort((left, right) => left - right)
            .join("、");
          await this.appendLog(project, "[" + now() + "] start blocked: alternate listening instance(s) "
            + formatListeningInstanceLog(alternateInstances) + ", target port=" + projectPort + "\n");
          const error = new Error(
            "无法启动：项目已有实例监听端口 " + ports
            + "；请先关闭现有实例，再启动目标端口 " + projectPort
          );
          error.statusCode = 409;
          error.code = "PROJECT_ALTERNATE_INSTANCE_RUNNING";
          error.details = {
            code: error.code,
            targetPort: projectPort,
            instances: alternateInstances
          };
          throw error;
        }
      } else {
        const externalPids = await this.findExternalPids(project, new Set());
        if (externalPids.length) {
          await this.appendLog(project, "[" + now() + "] start skipped: detected external pid(s) " + externalPids.join(", ") + "\n");
          return {
            ok: true,
            alreadyRunning: true,
            external: true,
            externalPids,
            message: "\u68c0\u6d4b\u5230\u9879\u76ee\u5df2\u5728\u8fd0\u884c",
            runtime: this.getRuntimeState(project.id)
          };
        }
      }
    }

    if (OPENABLE_TYPES.has(project.type)) {
      await this.openProject(project);
      await this.appendLog(project, `[${now()}] opened ${project.type}\n`);
      return {
        ok: true,
        message: "\u5df2\u6253\u5f00\u9879\u76ee",
        runtime: null
      };
    }

    if (!RUNNABLE_TYPES.has(project.type)) {
      throw new Error(`Unsupported project type: ${project.type}`);
    }

    const launch = this.createLaunchSpec(project);
    throwIfStartupCancelled(options.signal);
    const instanceId = randomUUID();
    const controlContext = {
      instanceId,
      runId: options.runContext?.runId || "",
      ports: resolveProjectPorts(project),
      owner: "workbench"
    };
    await this.runExternalControlAction(project, "prepareManagedStart", controlContext);
    let startFailureReported = false;
    const reportManagedStartFailed = async (error) => {
      if (startFailureReported) return;
      startFailureReported = true;
      try {
        await this.runExternalControlAction(project, "managedStartFailed", {
          ...controlContext,
          errorCode: String(error?.code || "PROJECT_START_FAILED")
        });
      } catch (controlError) {
        await this.appendLog(project, `[${now()}] external control failure cleanup failed: ${controlError.message}\n`);
      }
    };
    const startedAt = Date.now();
    const state = {
      instanceId,
      child: null,
      pid: null,
      servicePids: [],
      processIdentities: [],
      identityRequired: false,
      lineageVerified: false,
      source: "managed",
      adoptedAt: null,
      running: false,
      startedAt,
      launchConfirmedAt: null,
      launcherExitObserved: false,
      exitedAt: null,
      exitCode: null,
      signal: null,
      lastError: null,
      stoppedByUser: false,
      starting: true,
      stopping: false
    };
    const states = this.getProcessStates(project.id);
    states.push(state);
    this.processes.set(project.id, states);
    this.compactProcessStates(project.id);

    let child;
    try {
      await this.appendLog(project, `[${now()}] start ${project.type}: ${launch.display} instance=${instanceId}\n`);
      await appendRunLog(options, `准备执行 ${project.type}: ${launch.display}\n`);
      reportStage(options, "spawning", "正在创建启动进程", { command: launch.display });
      child = this.launchProjectProcess(project, launch, instanceId, options);
      state.pid = child.pid || null;
      state.running = true;
      options.runContext?.markLaunched?.(state.pid);
    } catch (error) {
      state.starting = false;
      state.running = false;
      state.exitedAt = Date.now();
      state.lastError = error.message;
      this.compactProcessStates(project.id);
      this.saveRuntimeState();
      await this.appendLog(project, `[${now()}] process spawn failed: ${error.message}\n`);
      await appendRunLog(options, `创建进程失败：${error.message}\n`);
      await reportManagedStartFailed(error);
      throw error;
    }

    let launchConfirmed = false;
    const spawnReady = new Promise((resolve, reject) => {
      child.once("spawn", () => {
        launchConfirmed = true;
        state.pid = child.pid || state.pid;
        state.launchConfirmedAt = Date.now();
        invalidateProcessSnapshot();
        resolve();
      });

      child.once("error", (error) => {
        invalidateProcessSnapshot();
        state.launcherExitObserved = true;
        state.running = false;
        state.exitedAt = Date.now();
        state.lastError = error.message;
        state.stoppedByUser = false;
        this.compactProcessStates(project.id);
        this.saveRuntimeState();
        if (!launchConfirmed) {
          reject(error);
          return;
        }
        this.appendLog(project, `[${now()}] process error: ${error.message}\n`).catch(() => {});
      });
    });

    child.once("exit", (code, signal) => {
      invalidateProcessSnapshot();
      state.launcherExitObserved = true;
      this.captureStateProcessTree(state, { fresh: true });
      state.exitedAt = Date.now();
      state.exitCode = normalizeProcessExitCode(code, signal);
      state.signal = signal;
      state.running = this.isStateAlive(state);
      this.compactProcessStates(project.id);
      this.saveRuntimeState();
      this.appendLog(project, `[${now()}] process exited: ${describeProcessExit(code, signal)} signal=${signal || ""}\n`).catch(() => {});
    });

    try {
      await spawnReady;
      reportStage(options, "waiting_process", `启动进程已创建${state.pid ? `（PID ${state.pid}）` : ""}`);
    } catch (error) {
      await this.appendLog(project, `[${now()}] process spawn failed: ${error.message}\n`);
      await appendRunLog(options, `进程启动失败：${error.message}\n`);
      await reportManagedStartFailed(error);
      throw error;
    }

    if (!Number.isInteger(Number(state.pid)) || Number(state.pid) <= 0) {
      const error = new Error("The independent process started without a valid PID");
      await this.appendLog(project, `[${now()}] process spawn failed: ${error.message}\n`);
      await reportManagedStartFailed(error);
      throw error;
    }

    this.compactProcessStates(project.id);
    this.saveRuntimeState();
    this.scheduleManagedProcessCapture(project.id, state);

    let startup;
    try {
      startup = await this.confirmProjectStartup(project, state, options);
    } catch (error) {
      state.starting = false;
      state.lastError = error.message;
      this.saveRuntimeState();
      await this.appendLog(project, `[${now()}] startup confirmation failed: ${error.message}\n`);
      await appendRunLog(options, `启动确认失败：${error.message}\n`);
      await reportManagedStartFailed(error);
      throw error;
    }

    try {
      await this.runExternalControlAction(project, "managedStarted", {
        ...controlContext,
        pids: this.getLiveStatePids(state),
        launcherPid: state.pid
      });
    } catch (error) {
      await this.appendLog(project, `[${now()}] external control managedStarted failed: ${error.message}\n`);
      try {
        await this.stopProject(project);
      } catch (stopError) {
        await this.appendLog(project, `[${now()}] rollback after control failure failed: ${stopError.message}\n`);
      }
      throw error;
    }

    return {
      ok: true,
      message: startup.confirmed
        ? (startup.ports.length ? `项目已启动，端口 ${startup.ports.join("、")} 已就绪` : "项目进程已启动")
        : (project.allowMultiple && runningStates.length ? "\u5df2\u542f\u52a8\u65b0\u7684\u9879\u76ee\u5b9e\u4f8b" : "\u542f\u52a8\u547d\u4ee4\u5df2\u53d1\u9001"),
      runtime: this.getRuntimeState(project.id)
    };
  }

  async stopProject(project) {
    invalidateProcessSnapshot();
    const processes = await this.getWindowsProcessesAsync({ fresh: true });
    const sanitizationReports = [];
    this.reconcileProjectProcesses(project, {
      processes,
      sanitizationReports
    });
    const unsafeReports = sanitizationReports.filter((report) => report.removedPids.length);
    if (unsafeReports.length) {
      const removedCount = unsafeReports.reduce((sum, report) => sum + report.removedPids.length, 0);
      const error = new Error(
        `检测到并已清理 ${removedCount} 个错误进程记录。为避免误关其他程序，本次停止已取消，请刷新状态后重试。`
      );
      error.statusCode = 409;
      error.details = { sanitizationReports: unsafeReports };
      throw error;
    }
    const candidateStates = this.getRunningStates(project.id, { processes });
    let runningStates = [];
    const verifiedPids = [];
    let discardedStaleState = false;
    for (const state of candidateStates) {
      const livePids = this.getLiveStatePids(state, { processes });
      if (livePids.length) {
        runningStates.push(state);
        verifiedPids.push(...livePids);
        continue;
      }

      state.running = false;
      state.stopping = false;
      state.exitedAt = state.exitedAt || Date.now();
      discardedStaleState = true;
    }
    let rootPids = [...new Set(verifiedPids)];
    let trackedPids = new Set(this.getTrackedProcessTreePids(rootPids, { processes }));
    const externalPids = await this.findExternalPids(project, trackedPids, { processes });

    const finalVerifiedPids = [];
    runningStates = runningStates.filter((state) => {
      const livePids = this.getLiveStatePids(state, { processes });
      if (livePids.length) {
        finalVerifiedPids.push(...livePids);
        return true;
      }
      state.running = false;
      state.stopping = false;
      state.exitedAt = state.exitedAt || Date.now();
      discardedStaleState = true;
      return false;
    });
    rootPids = [...new Set(finalVerifiedPids)];
    trackedPids = new Set(this.getTrackedProcessTreePids(rootPids, { processes }));
    if (discardedStaleState) this.saveRuntimeState();

    if (!runningStates.length && !externalPids.length) {
      throw new Error("\u5f53\u524d\u6ca1\u6709\u53ef\u505c\u6b62\u7684\u8fd0\u884c\u4e2d\u8fdb\u7a0b");
    }

    if (externalPids.length && !project.allowStopExternal) {
      throw new Error("\u68c0\u6d4b\u5230\u5916\u90e8\u8fdb\u7a0b PID: " + externalPids.join(", ") + "\uff0c\u9700\u5728\u8bbe\u7f6e\u4e2d\u5f00\u542f\u5141\u8bb8\u505c\u6b62\u5916\u90e8\u8fdb\u7a0b");
    }

    if (runningStates.length) {
      await this.runExternalControlAction(project, "prepareManagedStop", {
        owner: "stopped",
        ports: resolveProjectPorts(project),
        pids: rootPids,
        sources: [...new Set(runningStates.map((state) => state.source || "managed"))]
      });
    }
    const externalStopHandled = Boolean(
      externalPids.length && this.hasExternalControlAction(project, "stopExternal")
    );
    if (externalStopHandled) {
      await this.runExternalControlAction(project, "stopExternal", {
        owner: "stopped",
        ports: resolveProjectPorts(project),
        pids: externalPids
      });
    }

    await this.appendLog(project, "[" + now() + "] stop requested for " + runningStates.length + " tracked process(es), " + externalPids.length + " external process(es)\n");
    const allTargetPids = [...new Set([...trackedPids, ...externalPids])];
    const killTargets = this.getIndependentProcessRoots([
      ...rootPids,
      ...(externalStopHandled ? [] : externalPids)
    ], { processes });
    assertSafeProcessTreeTargets(killTargets, processes);
    await this.appendLog(project, "[" + now() + "] stop targets: root pid(s)="
      + (killTargets.join(", ") || "none") + ", process pid(s)="
      + (allTargetPids.join(", ") || "none") + "\n");
    for (const state of runningStates) {
      state.stoppedByUser = true;
      state.stopping = true;
    }
    this.saveRuntimeState();
    let stopCompleted = false;
    let finalProcesses = processes;

    try {
      for (const pid of killTargets) {
        await this.killProcessTree(pid, { processes });
      }

      const settled = await this.waitForProjectStop(project, allTargetPids);
      if (!settled) {
        throw new Error("\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001\uff0c\u4f46\u8fdb\u7a0b\u6216\u7aef\u53e3\u5728 5 \u79d2\u5185\u672a\u5b8c\u5168\u9000\u51fa");
      }
      stopCompleted = true;
    } finally {
      invalidateProcessSnapshot();
      finalProcesses = await this.getWindowsProcessesAsync({ fresh: true });
      const stoppedAt = Date.now();
      for (const state of runningStates) {
        state.stopping = false;
        if (!this.isStateAlive(state, { processes: finalProcesses })) {
          state.running = false;
          state.exitedAt = stoppedAt;
        } else {
          state.stoppedByUser = false;
        }
      }
      if (stopCompleted) {
        const latestState = this.getProcessStates(project.id, { processes: finalProcesses }).reduce((current, state) => (
          !current || state.startedAt > current.startedAt ? state : current
        ), null);
        if (latestState) latestState.stoppedByUser = true;
      }
      this.saveRuntimeState();
    }

    for (const pid of externalPids) {
      await this.appendLog(project, "[" + now() + "] stopped external process: pid=" + pid + "\n");
    }

    return {
      ok: true,
      message: externalPids.length
        ? "\u9879\u76ee\u5df2\u505c\u6b62\uff0c\u5305\u542b " + externalPids.length + " \u4e2a\u5916\u90e8\u8fdb\u7a0b"
        : (runningStates.length > 1 ? "\u9879\u76ee\u5df2\u505c\u6b62\uff0c\u5171 " + runningStates.length + " \u4e2a\u5b9e\u4f8b" : "\u9879\u76ee\u5df2\u505c\u6b62"),
      runtime: this.getRuntimeState(project.id, { processes: finalProcesses })
    };
  }

  async stopPortOwner(project, options = {}) {
    this.assertProjectShape(project);
    if (!project.allowStopExternal) {
      const error = new Error("项目未开启“允许停止外部进程”，拒绝关闭端口占用进程");
      error.statusCode = 403;
      throw error;
    }

    const projectPort = resolveProjectPort(project);
    if (!Number.isInteger(projectPort)) {
      throw new Error("项目未配置可检测的端口");
    }

    invalidateProcessSnapshot();
    const open = await this.isPortOpen(project.host || "127.0.0.1", projectPort);
    if (!open) {
      const error = new Error("端口 " + projectPort + " 已释放，无需关闭进程");
      error.statusCode = 409;
      throw error;
    }

    const portPids = normalizePidList(await this.findPortPids(projectPort));
    const runtimePids = new Set(this.getRuntimeState(project.id)?.pids || []);
    const ownership = this.classifyProjectPids(project, portPids, {
      runtimePids,
      knownProjects: options.projects,
      fresh: true
    });
    if (ownership.ownedPids.length || !ownership.foreignPids.length) {
      const error = new Error("端口占用状态已变化，请刷新后使用项目的正常停止或接管操作");
      error.statusCode = 409;
      throw error;
    }

    const targetPids = normalizePidList(ownership.foreignPids);
    const expectedPids = normalizePidList(options.expectedPids);
    if (!expectedPids.length || !samePidSet(expectedPids, targetPids)) {
      const error = new Error("端口占用 PID 已变化，已取消操作，请刷新后重试");
      error.statusCode = 409;
      error.details = { expectedPids, currentPids: targetPids };
      throw error;
    }

    assertSafePortOwnerTargets(ownership.conflicts, targetPids);
    const identities = new Map();
    for (const pid of targetPids) {
      const identity = this.getProcessIdentity(pid, { fresh: true });
      if (!identity) {
        const error = new Error("无法验证 PID " + pid + " 的进程身份，已取消关闭");
        error.statusCode = 409;
        throw error;
      }
      identities.set(pid, identity);
    }

    const verifiedPortPids = normalizePidList(await this.findPortPids(projectPort));
    if (!targetPids.every((pid) => verifiedPortPids.includes(pid))) {
      const error = new Error("端口占用进程在确认后发生变化，已取消关闭");
      error.statusCode = 409;
      throw error;
    }
    for (const pid of targetPids) {
      const currentIdentity = this.getProcessIdentity(pid, { fresh: true });
      if (!processIdentityMatches(identities.get(pid), currentIdentity)) {
        const error = new Error("PID " + pid + " 的进程身份已变化，已取消关闭");
        error.statusCode = 409;
        throw error;
      }
    }

    await this.appendLog(project, "[" + now() + "] confirmed stop for conflicting port owner(s): "
      + targetPids.join(", ") + ", port=" + projectPort + "\n");
    const killTargets = this.getIndependentProcessRoots(targetPids);
    for (const pid of killTargets) {
      await this.killProcessTree(pid);
    }

    const settled = await waitForProjectStop(project, targetPids, {
      isPidAlive: (pid) => this.isPidAlive(pid),
      isPortOpen: (host, port) => this.isPortOpen(host, port)
    });
    invalidateProcessSnapshot();
    if (!settled) {
      throw new Error("占用进程已关闭，但端口 " + projectPort + " 在 5 秒内未释放");
    }

    for (const pid of targetPids) {
      await this.appendLog(project, "[" + now() + "] stopped conflicting port owner: pid=" + pid + "\n");
    }
    return {
      ok: true,
      stoppedPids: targetPids,
      message: "已关闭占用端口 " + projectPort + " 的进程",
      runtime: this.getRuntimeState(project.id)
    };
  }

  async stopAlternateInstances(project, options = {}) {
    this.assertProjectShape(project);
    if (project.allowMultiple !== false) {
      const error = new Error("项目未启用严格单实例模式");
      error.statusCode = 409;
      throw error;
    }
    if (!project.allowStopExternal) {
      const error = new Error("项目未开启“允许停止外部进程”，拒绝关闭其他端口实例");
      error.statusCode = 403;
      throw error;
    }

    const targetPort = resolveProjectPort(project);
    if (!Number.isInteger(targetPort)) throw new Error("项目未配置目标端口");

    const expectedInstances = normalizeExpectedListeningInstances(options.expectedInstances, targetPort);
    if (!expectedInstances.length) {
      const error = new Error("缺少待关闭实例信息，请刷新后重试");
      error.statusCode = 409;
      throw error;
    }

    invalidateProcessSnapshot();
    const runtimePids = new Set(this.getRuntimeState(project.id)?.pids || []);
    const currentDiscovery = await this.findProjectListeningInstances(project, {
      runtimePids,
      fresh: true
    });
    const { alternateInstances: currentInstances } = partitionProjectListeningInstances(
      project,
      currentDiscovery
    );
    if (!sameListeningInstanceSet(expectedInstances, currentInstances)) {
      const error = new Error("现有实例的端口或 PID 已变化，已取消关闭，请刷新后重试");
      error.statusCode = 409;
      error.details = { expectedInstances, currentInstances };
      throw error;
    }

    for (const instance of currentInstances) {
      for (const port of getListeningInstancePorts(instance)) {
        const configuredOwner = (options.projects || []).find((candidate) => (
          candidate?.id !== project.id && resolveProjectPorts(candidate).includes(port)
        ));
        if (configuredOwner) {
          const ownerOwnership = this.classifyProjectPids(
            configuredOwner,
            instance.pids || [],
            { knownProjects: options.projects || [], fresh: true }
          );
          if (!ownerOwnership.ownedPids.length) {
            continue;
          }
          const error = new Error(
            "端口 " + port + " 已配置给项目“" + configuredOwner.name
            + "”且监听进程属于该项目，拒绝作为当前项目实例关闭"
          );
          error.statusCode = 409;
          throw error;
        }
      }
    }

    const listenerPids = normalizePidList(currentInstances.flatMap((instance) => instance.pids || []));
    const rootPids = normalizePidList(currentInstances.flatMap((instance) => instance.rootPids || []));
    const ports = [...new Set(currentInstances.flatMap(getListeningInstancePorts))]
      .sort((left, right) => left - right);
    assertSafeAlternateInstanceTargets(currentInstances, rootPids);

    const identities = new Map();
    for (const pid of rootPids) {
      const identity = this.getProcessIdentity(pid, { fresh: true });
      if (!identity) {
        const error = new Error("无法验证实例根进程 PID " + pid + "，已取消关闭");
        error.statusCode = 409;
        throw error;
      }
      identities.set(pid, identity);
    }

    const verifiedDiscovery = await this.findProjectListeningInstances(project, {
      runtimePids,
      fresh: true
    });
    const { alternateInstances: verifiedInstances } = partitionProjectListeningInstances(
      project,
      verifiedDiscovery
    );
    if (!sameListeningInstanceSet(currentInstances, verifiedInstances)) {
      const error = new Error("实例在确认后发生变化，已取消关闭");
      error.statusCode = 409;
      throw error;
    }
    const verifiedRootPids = normalizePidList(verifiedInstances.flatMap((instance) => instance.rootPids || []));
    if (!samePidSet(rootPids, verifiedRootPids)) {
      const error = new Error("实例根进程已变化，已取消关闭");
      error.statusCode = 409;
      throw error;
    }
    for (const pid of rootPids) {
      if (!processIdentityMatches(identities.get(pid), this.getProcessIdentity(pid, { fresh: true }))) {
        const error = new Error("PID " + pid + " 的进程身份已变化，已取消关闭");
        error.statusCode = 409;
        throw error;
      }
    }

    await this.appendLog(project, "[" + now() + "] confirmed stop for alternate instance(s): "
      + formatListeningInstanceLog(currentInstances) + "\n");
    for (const pid of this.getIndependentProcessRoots(rootPids)) {
      await this.killProcessTree(pid);
    }

    const settled = await waitForListeningInstancesStop(listenerPids, ports, {
      isPidAlive: (pid) => this.isPidAlive(pid),
      findPortPids: (port) => this.findPortPids(port)
    });
    invalidateProcessSnapshot();
    if (!settled) {
      throw new Error("现有实例已收到关闭命令，但端口 " + ports.join("、") + " 在 5 秒内未完全释放");
    }

    await this.appendLog(project, "[" + now() + "] stopped alternate instance root pid(s): "
      + rootPids.join(", ") + "\n");
    return {
      ok: true,
      stoppedPids: listenerPids,
      stoppedRootPids: rootPids,
      stoppedPorts: ports,
      message: "已关闭端口 " + ports.join("、") + " 的现有实例",
      runtime: this.getRuntimeState(project.id)
    };
  }

  async restartPortOwner(project, options = {}) {
    await this.stopPortOwner(project, options);
    await delay(800);
    const result = await this.startProject(project, { projects: options.projects });
    return {
      ...result,
      message: "已关闭端口占用进程并重新启动项目"
    };
  }

  waitForProjectStop(project, pids, options = {}) {
    if (options.isPortOpen) {
      return waitForProjectStop(project, pids, options);
    }

    const targetPids = new Set((pids || []).map(Number));
    return waitForProjectStop(project, pids, {
      ...options,
      isPortOpen: async (host, port) => {
        const open = await this.isPortOpen(host, port);
        if (!open) return false;

        const portPids = await this.findPortPids(port);
        if (!portPids.length) return true;

        const processes = await this.getWindowsProcessesAsync({ fresh: true });
        const ownership = this.classifyProjectPids(project, portPids, {
          runtimePids: targetPids,
          processes
        });
        return ownership.ownedPids.length > 0;
      }
    });
  }

  async findPortConflicts(project, trackedPids = new Set(), options = {}) {
    const projectPort = resolveProjectPort(project);
    if (!Number.isInteger(projectPort)) {
      return {
        port: null,
        portPids: [],
        ownedPids: [],
        conflictPids: [],
        conflicts: [],
        unverified: false,
        portStates: []
      };
    }

    const portStates = [];
    for (const port of resolveProjectPorts(project)) {
      const open = await this.isPortOpen(project.host || "127.0.0.1", port);
      if (!open) {
        portStates.push({
          port,
          portPids: [],
          ownedPids: [],
          conflictPids: [],
          conflicts: [],
          unverified: false
        });
        continue;
      }

      const portPids = await this.findPortPids(port);
      const ownership = this.classifyProjectPids(project, portPids, {
        runtimePids: trackedPids,
        knownProjects: options.projects,
        fresh: true
      });
      const untrackedOwnedPids = ownership.ownedPids.filter((pid) => !trackedPids.has(pid));
      const auxiliaryOwnedConflicts = port === projectPort
        ? []
        : untrackedOwnedPids.map((pid) => ({ pid, name: "项目现有进程" }));
      portStates.push({
        port,
        portPids,
        ownedPids: ownership.ownedPids,
        conflictPids: [...new Set([
          ...ownership.foreignPids,
          ...auxiliaryOwnedConflicts.map((conflict) => conflict.pid)
        ])],
        conflicts: [...ownership.conflicts, ...auxiliaryOwnedConflicts],
        unverified: portPids.length === 0 && trackedPids.size === 0
      });
    }

    const primaryState = portStates.find((state) => state.port === projectPort);
    return {
      port: projectPort,
      portPids: primaryState?.portPids || [],
      ownedPids: primaryState?.ownedPids || [],
      conflictPids: primaryState?.conflictPids || [],
      conflicts: primaryState?.conflicts || [],
      unverified: Boolean(primaryState?.unverified),
      portStates
    };
  }

  async findExternalPids(project, trackedPids, options = {}) {
    const pids = new Set();
    const processOptions = Array.isArray(options.processes)
      ? { processes: options.processes }
      : { fresh: true };

    for (const port of resolveProjectPorts(project)) {
      const portPids = await this.findPortPids(port);
      const ownership = this.classifyProjectPids(project, portPids, {
        runtimePids: trackedPids,
        ...processOptions
      });
      for (const pid of ownership.ownedPids) {
        pids.add(Number(pid));
      }
    }

    if (project.detectExternal !== false) {
      for (const pid of await this.findProjectPids(project, processOptions)) {
        pids.add(Number(pid));
      }
    }

    const candidates = [...pids].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    const memory = trackedPids.size && candidates.length
      ? this.getProcessMemoryInfo([...candidates, ...trackedPids], {
        trackHistory: false,
        ...processOptions
      })
      : null;
    const managedLineagePids = getTrackedAncestorPids(candidates, trackedPids, memory?.processes || []);
    return candidates.filter((pid) => !trackedPids.has(pid) && !managedLineagePids.has(pid));
  }

  trackServicePids(projectId, pids, options = {}) {
    const servicePids = normalizePidList(pids);
    if (!servicePids.length) return false;

    const states = this.getProcessStates(projectId, options);
    const identityOptions = Array.isArray(options.processes) ? options : { fresh: true };
    const nowMs = Date.now();
    const target = states.find((state) => state.running)
      || states.find((state) => (
        state.source !== "adopted"
        && !state.stoppedByUser
        && nowMs - Number(state.startedAt || 0) <= SERVICE_CAPTURE_WINDOW_MS
      ));
    if (!target) return false;

    const knownPids = new Set(normalizePidList(target.servicePids));
    const identities = normalizeProcessIdentities(target.processIdentities);
    let changed = false;

    for (const pid of servicePids) {
      if (knownPids.has(pid)) continue;
      const identity = this.getProcessIdentity(pid, identityOptions);
      if (!identity) continue;
      knownPids.add(pid);
      identities.push(identity);
      changed = true;
    }

    if (!changed) return false;
    target.servicePids = [...knownPids];
    target.processIdentities = identities;
    target.identityRequired = true;
    target.lineageVerified = true;
    target.running = true;
    target.exitedAt = null;
    target.stoppedByUser = false;
    target.source = target.source || "managed";
    this.processes.set(projectId, compactProcessStates(states));
    invalidateProcessSnapshot();
    this.saveRuntimeState();
    return true;
  }

  async adoptProject(project, options = {}) {
    this.assertProjectShape(project);
    const runningStates = this.getRunningStates(project.id);
    if (runningStates.length) {
      return {
        ok: true,
        alreadyManaged: true,
        message: "\u9879\u76ee\u5df2\u7531\u7ba1\u7406\u53f0\u8ddf\u8e2a",
        runtime: this.getRuntimeState(project.id)
      };
    }

    const projectPort = resolveProjectPort(project);
    let candidates = [];
    if (Number.isInteger(projectPort)) {
      const open = await this.isPortOpen(project.host || "127.0.0.1", projectPort);
      if (!open) {
        throw new Error("\u914d\u7f6e\u7aef\u53e3 " + projectPort + " \u5f53\u524d\u4e0d\u53ef\u8bbf\u95ee\uff0c\u65e0\u6cd5\u63a5\u7ba1");
      }

      const portPids = await this.findPortPids(projectPort);
      const ownership = this.classifyProjectPids(project, portPids, {
        runtimePids: new Set(),
        knownProjects: options.projects,
        fresh: true
      });
      if (ownership.foreignPids.length) {
        throw new Error("\u7aef\u53e3 " + projectPort + " \u5b58\u5728\u5176\u4ed6\u9879\u76ee\u6216\u672a\u77e5\u8fdb\u7a0b\uff0c\u62d2\u7edd\u63a5\u7ba1");
      }
      candidates = normalizePidList(ownership.ownedPids);
    } else {
      const projectPids = await this.findProjectPids(project, { fresh: true });
      candidates = this.getIndependentProcessRoots(projectPids);
    }

    if (!candidates.length) {
      throw new Error("\u672a\u627e\u5230\u53ef\u5b89\u5168\u63a5\u7ba1\u7684\u9879\u76ee\u8fdb\u7a0b");
    }
    if (candidates.length !== 1) {
      throw new Error("\u68c0\u6d4b\u5230 " + candidates.length + " \u4e2a\u5019\u9009\u8fdb\u7a0b\uff0c\u65e0\u6cd5\u552f\u4e00\u786e\u5b9a\u670d\u52a1\u5b9e\u4f8b");
    }

    const pid = candidates[0];
    if (pid === process.pid) {
      this.processes.delete(project.id);
      this.saveRuntimeState();
      await this.appendLog(project, "[" + now() + "] current workbench process recognized: pid=" + pid + "\n");
      return {
        ok: true,
        alreadyManaged: true,
        selfManaged: true,
        pid,
        message: "当前项目管理台后台已在运行，无需接管",
        runtime: null
      };
    }

    const identity = this.getProcessIdentity(pid, { fresh: true });
    if (!identity) {
      throw new Error("\u65e0\u6cd5\u8bfb\u53d6 PID " + pid + " \u7684\u521b\u5efa\u65f6\u95f4\u548c\u547d\u4ee4\u6307\u7eb9\uff0c\u62d2\u7edd\u63a5\u7ba1");
    }

    await this.runExternalControlAction(project, "prepareAdopt", {
      owner: "workbench",
      ports: resolveProjectPorts(project),
      pids: [pid],
      processCreatedAt: identity.createdAt || null,
      commandFingerprint: identity.commandFingerprint || ""
    });

    const adoptedAt = Date.now();
    const state = {
      instanceId: randomUUID(),
      child: null,
      pid,
      servicePids: [pid],
      processIdentities: [identity],
      identityRequired: true,
      lineageVerified: true,
      source: "adopted",
      adoptedAt,
      running: true,
      startedAt: identity.createdAt || adoptedAt,
      launchConfirmedAt: identity.createdAt || adoptedAt,
      exitedAt: null,
      exitCode: null,
      signal: null,
      lastError: null,
      stoppedByUser: false,
      stopping: false,
      restored: false
    };

    this.processes.set(project.id, [state]);
    this.saveRuntimeState();
    await this.appendLog(project, "[" + now() + "] adopted external process: pid=" + pid + "\n");
    return {
      ok: true,
      adopted: true,
      pid,
      message: "\u5df2\u63a5\u7ba1\u5916\u90e8\u8fdb\u7a0b PID " + pid,
      runtime: this.getRuntimeState(project.id)
    };
  }

  async restartProject(project, options = {}) {
    const runningStates = this.getRunningStates(project.id);
    const trackedPids = new Set(this.getTrackedProcessTreePids(
      runningStates.flatMap((state) => this.getLiveStatePids(state))
    ));
    const externalPids = await this.findExternalPids(project, trackedPids);
    if (runningStates.length || externalPids.length) {
      await this.stopProject(project);
      await delay(800);
    }
    return this.startProject(project, options);
  }

  async openProject(project) {
    this.assertProjectShape(project);

    if (project.url) {
      assertValidUrl(project.url);
      await openTarget(project.url, "url");
      await this.appendLog(project, `[${now()}] open url: ${project.url}\n`);
      return { ok: true, message: "已打开网址" };
    }

    const target = project.type === "folder" ? project.path : project.path || project.cwd;
    if (!target) {
      throw new Error("项目未配置可打开的 path、cwd 或 url");
    }

    assertPathExists(target);
    const openResult = await openTarget(target, project.type === "folder" ? "folder" : "file");
    await this.appendLog(project, `[${now()}] open path: ${target}\n`);
    return {
      ok: true,
      activated: openResult?.mode === "activated",
      message: openResult?.mode === "activated" ? "目录窗口已切换到前台" : "已打开路径"
    };
  }

  async openFolder(project) {
    const target = project.cwd || (project.type === "folder" ? project.path : path.dirname(project.path || ""));
    if (!target) {
      throw new Error("项目未配置可打开的目录");
    }
    assertPathExists(target);
    const stats = fs.statSync(target);
    const folder = stats.isDirectory() ? target : path.dirname(target);
    const openResult = await openTarget(folder, "folder");
    await this.appendLog(project, `[${now()}] open folder: ${folder}\n`);
    return {
      ok: true,
      activated: openResult?.mode === "activated",
      message: openResult?.mode === "activated" ? "目录窗口已切换到前台" : "已打开目录"
    };
  }

  async openFolderPath(target) {
    assertPathExists(target);
    const stats = fs.statSync(target);
    const folder = stats.isDirectory() ? target : path.dirname(target);
    const openResult = await openTarget(folder, "folder");
    return {
      ok: true,
      activated: openResult?.mode === "activated",
      message: openResult?.mode === "activated" ? "日志目录窗口已切换到前台" : "已打开日志目录"
    };
  }

  async openCodex(project) {
    this.assertProjectShape(project);

    if (!project.codexCwd) {
      throw new Error("未配置 Codex 项目目录");
    }

    const codexCwd = path.resolve(project.codexCwd);
    assertPathExists(codexCwd);
    if (!fs.statSync(codexCwd).isDirectory()) {
      throw new Error(`Codex 项目目录必须是目录: ${codexCwd}`);
    }

    await this.openCodexCli(codexCwd);
    await this.appendLog(project, `[${now()}] open codex: ${codexCwd}\n`);
    return { ok: true, codexAction: "opened", message: "已新开 Codex 窗口" };
  }

  async openCodexDiagnosis(project, diagnosticPath) {
    this.assertProjectShape(project);
    const codexCwd = path.resolve(project.codexCwd || project.cwd || path.dirname(project.path || ""));
    assertPathExists(codexCwd);
    if (!fs.statSync(codexCwd).isDirectory()) {
      throw new Error(`Codex 项目目录必须是目录: ${codexCwd}`);
    }
    assertPathExists(diagnosticPath);
    await this.openCodexDiagnosisCli(codexCwd, path.resolve(diagnosticPath));
    await this.appendLog(project, `[${now()}] open codex diagnosis: ${diagnosticPath}\n`);
    return {
      ok: true,
      codexAction: "diagnosis-opened",
      message: "已打开 Codex，并附带本次启动失败的诊断材料"
    };
  }

  openCodexDesktop() {
    return openCodexDesktopPowerShell();
  }

  async openCodexDesktopApp() {
    const desktop = await this.openCodexDesktop();
    return {
      ok: true,
      desktopAction: desktop.action,
      desktopPid: desktop.pid || null,
      message: desktop.action === "started"
        ? "ChatGPT/Codex 桌面程序已启动"
        : "已切换到 ChatGPT/Codex 桌面程序"
    };
  }

  openCodexCli(cwd) {
    return openCodexPowerShell(cwd);
  }

  openCodexDiagnosisCli(cwd, diagnosticPath) {
    return openCodexDiagnosisPowerShell(cwd, diagnosticPath);
  }

  async readLogs(project, maxBytes = 200000) {
    const file = resolveLogFile(project);
    if (!fs.existsSync(file)) {
      return "";
    }

    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  async appendLog(project, content) {
    const file = resolveLogFile(project);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, redact(content), "utf8");
  }

  loadRuntimeState() {
    const data = readRuntimeStateFile(this.runtimeStatePath);
    const captureCandidates = [];
    const nowMs = Date.now();
    for (const entry of data.projects || []) {
      if (!entry?.projectId || !Array.isArray(entry.states)) continue;
      const states = compactProcessStates(
        entry.states
          .map((state) => deserializeRuntimeState(
            state,
            (candidate) => this.isPersistedStateAlive(candidate)
          ))
          .filter(Boolean)
      );
      if (states.length) {
        this.processes.set(entry.projectId, states);
        for (const state of states) {
          const withinCaptureWindow = nowMs - Number(state.startedAt || 0) <= SERVICE_CAPTURE_WINDOW_MS;
          if (!state.stoppedByUser && withinCaptureWindow) {
            captureCandidates.push([entry.projectId, state]);
          }
        }
      }
    }

    for (const [projectId, state] of captureCandidates) {
      this.scheduleManagedProcessCapture(projectId, state);
    }
  }

  saveRuntimeState() {
    writeRuntimeStateFile({
      version: 3,
      updatedAt: now(),
      projects: [...this.processes.entries()].map(([projectId, states]) => ({
        projectId,
        states: (Array.isArray(states) ? states : [states]).map((state) => serializeRuntimeState(
          state,
          (candidate) => Boolean(candidate?.running)
        ))
      })).filter((entry) => entry.states.length)
    }, this.runtimeStatePath);
  }

  createLaunchSpec(project) {
    const cwd = project.cwd ? path.resolve(project.cwd) : process.cwd();
    assertPathExists(cwd);

    if (project.type === "exe") {
      if (!project.path) throw new Error("exe 项目缺少 path");
      assertPathExists(project.path);
      const hideConsole = isLauncherConsoleHidden(project);
      return {
        command: project.path,
        args: normalizeArgs(project.args),
        cwd,
        shell: false,
        windowsHide: hideConsole,
        display: project.path
      };
    }

    if (project.type === "bat") {
      if (!project.path) throw new Error("bat \u9879\u76ee\u7f3a\u5c11 path");
      assertPathExists(project.path);
      const batPath = path.resolve(project.path);
      const batCwd = project.cwd ? cwd : path.dirname(batPath);
      const commandLine = ["call", quoteCmdArg(batPath), ...normalizeArgs(project.args).map(quoteCmdArg)].join(" ");
      const hideConsole = isLauncherConsoleHidden(project);
      return {
        command: "cmd.exe",
        args: ["/d", "/c", commandLine],
        cwd: batCwd,
        shell: false,
        windowsHide: hideConsole,
        windowsVerbatimArguments: process.platform === "win32",
        display: project.path
      };
    }

    if (project.type === "cmd") {
      if (!project.command) throw new Error("cmd 项目缺少 command");
      const hideConsole = isLauncherConsoleHidden(project);
      const isWindows = process.platform === "win32";
      return {
        command: isWindows ? "cmd.exe" : (process.env.SHELL || "/bin/sh"),
        args: isWindows
          ? ["/d", "/s", "/c", project.command]
          : ["-c", project.command],
        cwd,
        shell: false,
        windowsHide: isWindows && hideConsole,
        display: project.command
      };
    }

    throw new Error(`Unsupported project type: ${project.type}`);
  }

  assertProjectShape(project) {
    if (!project || !project.id) {
      throw new Error("无效项目配置");
    }
  }
}

function getStatePid(state) {
  const pid = Number(state?.pid || state?.child?.pid || 0);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function normalizePidList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function getListeningInstancePorts(instance) {
  return [...new Set(
    (Array.isArray(instance?.ports) ? instance.ports : [instance?.port])
      .map(Number)
      .filter((port) => Number.isInteger(port) && port > 0)
  )].sort((left, right) => left - right);
}

function normalizeExpectedListeningInstances(values, excludedPort = null) {
  return (Array.isArray(values) ? values : [])
    .map((instance) => ({
      ports: getListeningInstancePorts(instance),
      pids: normalizePidList(instance?.pids)
    }))
    .filter((instance) => (
      instance.ports.length > 0
      && !instance.ports.includes(excludedPort)
      && instance.pids.length > 0
    ))
    .sort((left, right) => left.ports[0] - right.ports[0]);
}

function normalizeProcessIdentities(values) {
  return (Array.isArray(values) ? values : []).map((identity) => ({
    pid: Number(identity?.pid || 0),
    name: String(identity?.name || ""),
    createdAt: Number(identity?.createdAt || 0) || null,
    executablePath: String(identity?.executablePath || ""),
    commandFingerprint: String(identity?.commandFingerprint || "") || null
  })).filter((identity) => Number.isInteger(identity.pid) && identity.pid > 0);
}

function normalizeProcessSanitization(value) {
  if (!value || typeof value !== "object") return null;
  const at = Number(value.at || 0);
  const removedProcessCount = Number(value.removedProcessCount || 0);
  const rejectedEdgeCount = Number(value.rejectedEdgeCount || 0);
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(removedProcessCount) || removedProcessCount <= 0) {
    return null;
  }
  return {
    at,
    removedProcessCount: Math.floor(removedProcessCount),
    rejectedEdgeCount: Number.isFinite(rejectedEdgeCount) && rejectedEdgeCount > 0
      ? Math.floor(rejectedEdgeCount)
      : 0
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || Number(pid) === process.pid) {
    return false;
  }

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function getTrackedProcessTreePids(rootPids, options = {}) {
  const roots = [...new Set((rootPids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!roots.length) return [];

  const memory = getProcessMemoryInfo(roots, options);
  const descendants = Array.isArray(memory?.pids) ? memory.pids.map(Number) : [];
  return [...new Set([...roots, ...descendants].filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function getIndependentProcessRoots(pids, options = {}) {
  const candidates = [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (candidates.length < 2) return candidates;

  const memory = getProcessMemoryInfo(candidates, options);
  return collapseProcessTreePids(candidates, memory?.processes || []);
}

function collapseProcessTreePids(pids, processes) {
  const candidates = [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const candidateSet = new Set(candidates);
  const parentByPid = new Map(
    (processes || []).map((item) => [Number(item.pid), Number(item.parentPid) || null])
  );

  return candidates.filter((pid) => {
    const seen = new Set([pid]);
    let parentPid = parentByPid.get(pid);

    while (Number.isInteger(parentPid) && parentPid > 0 && !seen.has(parentPid)) {
      if (candidateSet.has(parentPid)) return false;
      seen.add(parentPid);
      parentPid = parentByPid.get(parentPid);
    }

    return true;
  });
}

function getTrackedAncestorPids(candidatePids, trackedPids, processes) {
  const candidates = new Set(normalizePidList(candidatePids));
  const tracked = trackedPids instanceof Set ? trackedPids : new Set(normalizePidList(trackedPids));
  const parentByPid = new Map(
    (processes || []).map((item) => [Number(item.pid), Number(item.parentPid) || null])
  );
  const ancestors = new Set();

  for (const trackedPid of tracked) {
    const seen = new Set([trackedPid]);
    let parentPid = parentByPid.get(trackedPid);
    while (Number.isInteger(parentPid) && parentPid > 0 && !seen.has(parentPid)) {
      seen.add(parentPid);
      if (candidates.has(parentPid)) ancestors.add(parentPid);
      parentPid = parentByPid.get(parentPid);
    }
  }

  return ancestors;
}

function compactProcessStates(states) {
  const list = (Array.isArray(states) ? states : [states]).filter(Boolean);
  const running = [];
  let latestStopped = null;

  for (const state of list) {
    // Independent projects are tracked only by scalar process identity. Keeping
    // a ChildProcess reference would unnecessarily retain handles and listeners.
    state.child = null;
    if (state.running || state.starting) {
      running.push(state);
      continue;
    }

    if (!latestStopped || Number(state.startedAt || 0) > Number(latestStopped.startedAt || 0)) {
      latestStopped = state;
    }
  }

  return running.length ? running : (latestStopped ? [latestStopped] : []);
}

function serializeRuntimeState(state, checkAlive = isPersistedStateAlive) {
  const pid = getStatePid(state);
  if (!pid) return null;
  return {
    instanceId: normalizeInstanceId(state.instanceId, pid, state.startedAt),
    pid,
    servicePids: normalizePidList(state.servicePids),
    processIdentities: normalizeProcessIdentities(state.processIdentities),
    identityRequired: true,
    lineageVerified: Boolean(state.lineageVerified),
    lastProcessSanitization: normalizeProcessSanitization(state.lastProcessSanitization),
    source: state.source === "adopted" ? "adopted" : "managed",
    adoptedAt: Number(state.adoptedAt || 0) || null,
    running: Boolean(state.running && checkAlive(state)),
    starting: Boolean(state.starting),
    startedAt: Number(state.startedAt || 0) || null,
    launchConfirmedAt: Number(state.launchConfirmedAt || 0) || null,
    startupConfirmedAt: Number(state.startupConfirmedAt || 0) || null,
    exitedAt: Number(state.exitedAt || 0) || null,
    exitCode: state.exitCode ?? null,
    signal: state.signal || null,
    lastError: state.lastError || null,
    stoppedByUser: Boolean(state.stoppedByUser)
  };
}

function deserializeRuntimeState(input, checkAlive = isPersistedStateAlive) {
  const pid = Number(input?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const servicePids = normalizePidList(input.servicePids);
  const processIdentities = normalizeProcessIdentities(input.processIdentities);
  const alive = Boolean(input.running && checkAlive({
    pid,
    servicePids,
    processIdentities,
    identityRequired: true
  }));
  return {
    instanceId: normalizeInstanceId(input.instanceId, pid, input.startedAt),
    pid,
    child: null,
    servicePids,
    processIdentities,
    identityRequired: true,
    lineageVerified: Boolean(input.lineageVerified),
    lastProcessSanitization: normalizeProcessSanitization(input.lastProcessSanitization),
    source: input.source === "adopted" ? "adopted" : "managed",
    adoptedAt: Number(input.adoptedAt || 0) || null,
    running: alive,
    starting: false,
    startedAt: Number(input.startedAt || 0) || null,
    launchConfirmedAt: Number(input.launchConfirmedAt || 0) || null,
    startupConfirmedAt: Number(input.startupConfirmedAt || 0) || null,
    exitedAt: alive ? (Number(input.exitedAt || 0) || null) : (Number(input.exitedAt || 0) || Date.now()),
    exitCode: input.exitCode ?? null,
    signal: input.signal || null,
    lastError: input.lastError || null,
    stoppedByUser: Boolean(input.stoppedByUser),
    stopping: false,
    restored: true
  };
}

function isPersistedStateAlive(state) {
  const identities = normalizeProcessIdentities(state?.processIdentities);
  const pids = [...new Set([getStatePid(state), ...normalizePidList(state?.servicePids)].filter(Boolean))];
  return pids.some((pid) => {
    if (!isPidAlive(pid)) return false;
    const expected = identities.find((identity) => identity.pid === pid);
    return Boolean(expected && processIdentityMatches(expected, getProcessIdentity(pid)));
  });
}

function readRuntimeStateFile(runtimeStatePath = RUNTIME_STATE_PATH) {
  try {
    if (!fs.existsSync(runtimeStatePath)) return { projects: [] };
    const parsed = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { projects: [] };
  } catch {
    return { projects: [] };
  }
}

function writeRuntimeStateFile(data, runtimeStatePath = RUNTIME_STATE_PATH) {
  const normalized = {
    ...data,
    projects: (data.projects || []).map((entry) => ({
      ...entry,
      states: (entry.states || []).filter(Boolean)
    })).filter((entry) => entry.states.length)
  };

  fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true });
  const tempPath = `${runtimeStatePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, runtimeStatePath);
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map(String) : [];
}

function createProjectEnvironment(project, baseEnv = process.env, instanceId = "", runContext = null) {
  const env = { ...baseEnv };
  const projectPort = resolveProjectPort(project);
  if (Number.isInteger(projectPort)) {
    env.PORT = String(projectPort);
  }
  env.PROJECT_LAUNCHER_PROJECT_ID = String(project?.id || "");
  env.PROJECT_LAUNCHER_INSTANCE_ID = String(instanceId || "");
  env.PROJECT_LAUNCHER_MANAGED = "1";
  const hideIntermediateConsoles = project?.hideLauncherConsole === undefined
    ? Boolean(project?.hideConsole)
    : Boolean(project.hideLauncherConsole);
  const showServiceConsoles = project?.showServiceConsoles !== false;
  const allowInteractiveConsole = project?.allowInteractiveConsole === undefined
    ? Boolean(project?.allowChildConsole)
    : Boolean(project.allowInteractiveConsole);
  env.PROJECT_LAUNCHER_HIDE_INTERMEDIATE_CONSOLES = hideIntermediateConsoles ? "1" : "0";
  env.PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES = showServiceConsoles ? "1" : "0";
  env.PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE = allowInteractiveConsole ? "1" : "0";
  env.PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE = allowInteractiveConsole ? "1" : "0";
  env.PROJECT_LAUNCHER_ROLE_RUNNER = path.join(ROOT_DIR, "scripts", "run-process-role.js");
  env.PROJECT_LAUNCHER_PROCESS_HOST = WINDOWS_MANAGED_PROCESS_HOST_PATH;
  env.PROJECT_LAUNCHER_PROCESS_HOST_VERSION = "1";
  if (runContext?.runId) {
    env.PROJECT_LAUNCHER_RUN_ID = String(runContext.runId);
  }
  if (runContext?.eventFile) {
    env.PROJECT_LAUNCHER_EVENT_FILE = String(runContext.eventFile);
  }
  if (runContext?.logDir) {
    env.PROJECT_LAUNCHER_LOG_DIR = String(runContext.logDir);
  }
  return env;
}

function shouldUseWindowsManagedProcessHost(project, launch) {
  if (process.platform !== "win32") return false;
  return isLauncherConsoleHidden(project) && Boolean(launch?.windowsHide);
}

function isLauncherConsoleHidden(project) {
  return project?.hideLauncherConsole === undefined
    ? Boolean(project?.hideConsole)
    : Boolean(project.hideLauncherConsole);
}

function createWindowsManagedProcessPlan(launch, output) {
  if (!fs.existsSync(WINDOWS_MANAGED_PROCESS_HOST_PATH)) {
    throw new Error(`Windows managed process host is missing: ${WINDOWS_MANAGED_PROCESS_HOST_PATH}`);
  }
  if (!output?.stdoutPath || !output?.stderrPath) {
    throw new Error("Windows managed process host requires file-backed stdout and stderr");
  }

  const executable = resolveWindowsExecutablePath(launch.command);
  return {
    version: 1,
    executable,
    commandLine: createWindowsCommandLine(
      executable,
      launch.args,
      Boolean(launch.windowsVerbatimArguments)
    ),
    cwd: String(launch.cwd),
    stdoutPath: path.resolve(output.stdoutPath),
    stderrPath: path.resolve(output.stderrPath),
    windowRole: "intermediate"
  };
}

function resolveWindowsExecutablePath(command, environment = process.env) {
  const executable = String(command || "").trim();
  if (process.platform !== "win32" || !executable || path.isAbsolute(executable)) {
    return executable;
  }

  const systemRoot = String(environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows").trim();
  const fileName = path.basename(executable).toLowerCase();
  const candidates = [];
  if (fileName === "cmd.exe") {
    candidates.push(environment.ComSpec, environment.COMSPEC, path.join(systemRoot, "System32", "cmd.exe"));
  } else if (fileName === "powershell.exe") {
    candidates.push(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }

  return candidates
    .map((candidate) => String(candidate || "").trim())
    .find((candidate) => candidate && fs.existsSync(candidate)) || executable;
}

function createWindowsCommandLine(command, args = [], verbatimArguments = false) {
  const executable = quoteWindowsProcessArgument(command);
  if (!args.length) return executable;
  const argumentLine = verbatimArguments
    ? args.map(String).join(" ")
    : args.map(quoteWindowsProcessArgument).join(" ");
  return `${executable} ${argumentLine}`;
}

function quoteWindowsProcessArgument(value) {
  const text = String(value);
  if (text && !/[\s"]/u.test(text)) return text;
  let result = '"';
  let backslashes = 0;
  for (const character of text) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function normalizeInstanceId(value, pid, startedAt) {
  const instanceId = String(value || "").trim();
  return instanceId || `legacy-${Number(pid) || 0}-${Number(startedAt) || 0}`;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function assertPathExists(target) {
  if (!target || !fs.existsSync(target)) {
    throw new Error(`路径不存在: ${target}`);
  }
}

function assertValidUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`不支持的网址协议: ${url.protocol}`);
  }
}

function openTarget(target, kind) {
  if (process.platform === "win32") {
    return openTargetWindows(target, kind);
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return spawnDetached(opener, [target]);
}

function openTargetWindows(target, kind) {
  const resolvedTarget = path.resolve(target);

  if (kind === "folder") {
    return runWindowsFolderOpener(resolvedTarget);
  }

  if (kind === "file") {
    return spawnDetached("cmd.exe", ["/d", "/s", "/c", "start", "", resolvedTarget], { windowsHide: false });
  }

  return spawnDetached("cmd.exe", ["/d", "/s", "/c", "start", "", target], { windowsHide: false });
}

function runWindowsFolderOpener(target) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Sta",
      "-File",
      WINDOWS_FOLDER_OPENER_PATH,
      "-Path",
      target
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(reject, new Error("打开目录超时"));
    }, 6000);

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
        finish(reject, new Error(detail ? `打开目录失败: ${detail}` : `打开目录失败，退出码: ${code}`));
        return;
      }

      const result = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      finish(resolve, { mode: result === "activated" ? "activated" : "opened" });
    });
  });
}

function spawnIndependentProcess(command, args, options = {}, spawnProcess = spawn) {
  const stdio = options.stdio || "ignore";
  const channels = Array.isArray(stdio) ? stdio : [stdio];
  if (channels.some((channel) => channel === "pipe" || channel === "ipc")) {
    throw new Error("Independent processes cannot use pipe or IPC stdio channels");
  }

  const child = spawnProcess(command, args, {
    ...options,
    detached: true,
    stdio
  });
  if (!child || typeof child.unref !== "function") {
    throw new Error("Independent process launcher did not return a ChildProcess");
  }
  child.unref();
  return child;
}

function spawnManagedProcessHost(command, args, options = {}, spawnProcess = spawn) {
  const stdio = options.stdio || "ignore";
  const channels = Array.isArray(stdio) ? stdio : [stdio];
  if (channels.some((channel) => channel === "pipe" || channel === "ipc")) {
    throw new Error("Managed process hosts cannot use pipe or IPC stdio channels");
  }

  // On Windows, detached PowerShell can exit 0 without honoring -File/-Command.
  // The native host creates the actual project in its own process group and
  // console, so this wrapper must stay non-detached while remaining unreferenced.
  const child = spawnProcess(command, args, {
    ...options,
    detached: false,
    stdio
  });
  if (!child || typeof child.unref !== "function") {
    throw new Error("Managed process host launcher did not return a ChildProcess");
  }
  child.unref();
  return child;
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnIndependentProcess(command, args, {
      windowsHide: false,
      ...options,
      stdio: "ignore"
    });

    let settled = false;
    let launched = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    child.once("spawn", () => {
      launched = true;
      setTimeout(() => {
        if (!settled) {
          finish(resolve);
        }
      }, 800);
    });

    child.once("error", (error) => {
      finish(reject, error);
    });

    child.once("exit", (code) => {
      if (settled) return;
      if (code === 0 && launched) {
        finish(resolve);
        return;
      }
      finish(reject, new Error(`Open command failed: ${command} exited with code ${code}`));
    });
  });
}

function openCodexPowerShell(cwd) {
  if (process.platform !== "win32") {
    throw new Error("当前只支持在 Windows PowerShell 中打开 Codex");
  }

  const command = `Set-Location -LiteralPath '${escapePowerShellString(cwd)}'; codex`;
  return spawnDetached("cmd.exe", [
    "/d",
    "/s",
    "/c",
    "start",
    "",
    "powershell.exe",
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    cwd,
    windowsHide: false
  });
}

function openCodexDesktopPowerShell() {
  if (process.platform !== "win32") {
    throw new Error("当前只支持在 Windows 中启动 ChatGPT/Codex 桌面程序");
  }
  if (codexDesktopLaunchPending) return codexDesktopLaunchPending;

  const pending = runPowerShellJsonScript(CODEX_DESKTOP_OPENER_PATH, 15000)
    .finally(() => {
      if (codexDesktopLaunchPending === pending) codexDesktopLaunchPending = null;
    });
  codexDesktopLaunchPending = pending;
  return pending;
}

function openCodexDiagnosisPowerShell(cwd, diagnosticPath) {
  if (process.platform !== "win32") {
    throw new Error("当前只支持在 Windows PowerShell 中打开 Codex 诊断会话");
  }
  return spawnDetached("powershell.exe", [
    "-NoLogo",
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    CODEX_DIAGNOSTIC_OPENER_PATH,
    "-WorkingDirectory",
    cwd,
    "-DiagnosticPath",
    diagnosticPath
  ], {
    cwd,
    windowsHide: false
  });
}

function runPowerShellJsonScript(scriptPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Sta",
      "-File",
      scriptPath
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("启动 ChatGPT/Codex 桌面程序超时"));
    }, timeoutMs);

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
        const knownMessages = {
          CODEX_APP_NOT_INSTALLED: "未检测到 ChatGPT/Codex Windows 应用，请先安装桌面程序",
          CODEX_APP_LAUNCH_TIMEOUT: "ChatGPT/Codex 桌面程序启动超时"
        };
        finish(reject, new Error(knownMessages[detail] || detail || `启动 ChatGPT/Codex 桌面程序失败，退出码 ${code}`));
        return;
      }

      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        const result = JSON.parse(line || "{}");
        if (!result.ok || !["started", "activated"].includes(result.action)) {
          throw new Error("桌面程序启动结果无效");
        }
        finish(resolve, result);
      } catch (error) {
        finish(reject, new Error(`无法解析 ChatGPT/Codex 启动结果: ${error.message}`));
      }
    });
  });
}

function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

async function killProcessTree(pid) {
  const targetPid = Number(pid);
  if (targetPid === process.pid) {
    throw new Error("Refusing to stop the workbench backend process");
  }
  if (!Number.isInteger(targetPid) || targetPid <= 0 || !isPidAlive(targetPid)) return;

  if (process.platform === "win32") {
    const result = await runTaskkill(targetPid);
    if (await waitForPidExit(targetPid, TASKKILL_EXIT_TIMEOUT_MS)) return;

    const detail = result.output ? ": " + result.output : "";
    if (result.code === 0) {
      throw new Error("taskkill reported success, but PID " + targetPid + " is still running" + detail);
    }
    throw new Error("taskkill failed with exit code " + result.code + detail);
  }

  try {
    process.kill(targetPid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function runTaskkill(pid) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        output: decodeTaskkillOutput([...stdout, ...stderr])
      });
    });
  });
}

function decodeTaskkillOutput(chunks) {
  if (!chunks.length) return "";
  const output = new TextDecoder("gb18030").decode(Buffer.concat(chunks));
  return output.replace(/\s+/g, " ").trim().slice(0, 500);
}

async function waitForProjectStop(project, pids, options = {}) {
  const timeoutMs = Number(options.timeoutMs || STOP_SETTLE_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || STOP_SETTLE_POLL_INTERVAL_MS);
  const checkPidAlive = options.isPidAlive || isPidAlive;
  const checkPortOpen = options.isPortOpen || isPortOpen;
  const wait = options.delay || delay;
  const deadline = Date.now() + timeoutMs;
  const targets = [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const projectPort = resolveProjectPort(project);

  while (true) {
    const hasLivePid = targets.some((pid) => checkPidAlive(pid));
    const portOpen = Number.isInteger(projectPort)
      ? await checkPortOpen(project.host || "127.0.0.1", projectPort, Math.min(500, pollIntervalMs * 2))
      : false;

    if (!hasLivePid && !portOpen) return true;
    if (Date.now() >= deadline) return false;
    await wait(pollIntervalMs);
  }
}

async function waitForListeningInstancesStop(pids, ports, options = {}) {
  const timeoutMs = Number(options.timeoutMs || STOP_SETTLE_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || STOP_SETTLE_POLL_INTERVAL_MS);
  const checkPidAlive = options.isPidAlive || isPidAlive;
  const findPids = options.findPortPids || findPortPids;
  const wait = options.delay || delay;
  const deadline = Date.now() + timeoutMs;
  const targets = normalizePidList(pids);
  const targetPorts = [...new Set((ports || []).map(Number)
    .filter((port) => Number.isInteger(port) && port > 0))];

  while (true) {
    const hasLivePid = targets.some((pid) => checkPidAlive(pid));
    let hasListeningPort = false;
    for (const port of targetPorts) {
      if ((await findPids(port)).length) {
        hasListeningPort = true;
        break;
      }
    }

    if (!hasLivePid && !hasListeningPort) return true;
    if (Date.now() >= deadline) return false;
    await wait(pollIntervalMs);
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(50);
  }
  return !isPidAlive(pid);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportStage(options, stage, message, details = null) {
  if (typeof options?.onStage === "function") {
    options.onStage(stage, message, details);
  }
  if (typeof options?.runContext?.stage === "function") {
    options.runContext.stage(stage, message, details);
  }
}

function appendRunLog(options, message) {
  if (typeof options?.runContext?.log !== "function") return Promise.resolve();
  return Promise.resolve(options.runContext.log(message));
}

function throwIfStartupCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("启动任务已取消");
  error.name = "AbortError";
  error.code = "PROJECT_STARTUP_CANCELLED";
  error.statusCode = 409;
  error.details = { code: error.code };
  throw error;
}

async function waitWithSignal(ms, signal, wait = delay) {
  if (!signal) {
    await wait(ms);
    return;
  }
  throwIfStartupCancelled(signal);
  await Promise.race([
    wait(ms),
    new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        try {
          throwIfStartupCancelled(signal);
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms).unref?.();
    })
  ]);
}

function createStartupError(code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  error.details = { code, ...details };
  if (details.exitCode !== undefined) error.exitCode = details.exitCode;
  return error;
}

function samePidSet(left, right) {
  const leftPids = normalizePidList(left);
  const rightPids = normalizePidList(right);
  return leftPids.length === rightPids.length
    && leftPids.every((pid) => rightPids.includes(pid));
}

function sameListeningInstanceSet(left, right) {
  const signatures = (values) => normalizeExpectedListeningInstances(values)
    .map((instance) => instance.ports.join(",") + ":" + instance.pids.join(","));
  const leftSignatures = signatures(left);
  const rightSignatures = signatures(right);
  return leftSignatures.length === rightSignatures.length
    && leftSignatures.every((signature) => rightSignatures.includes(signature));
}

function formatListeningInstanceLog(instances) {
  return normalizeExpectedListeningInstances(instances)
    .map((instance) => "port(s)=" + instance.ports.join(",") + " pid(s)=" + instance.pids.join(","))
    .join("; ");
}

function assertSafeAlternateInstanceTargets(instances, rootPids) {
  const processesByPid = new Map(
    (instances || []).flatMap((instance) => instance.processes || [])
      .map((item) => [Number(item.pid), item])
  );
  for (const pid of rootPids) {
    const item = processesByPid.get(Number(pid));
    const name = String(item?.name || "").trim().toLowerCase();
    if (
      !item
      || pid <= 4
      || pid === process.pid
      || PROTECTED_PROCESS_NAMES.has(name)
    ) {
      const error = new Error("拒绝关闭无法验证或受保护的实例根进程 PID " + pid);
      error.statusCode = 409;
      throw error;
    }
  }
}

function assertSafePortOwnerTargets(conflicts, targetPids) {
  const conflictsByPid = new Map((conflicts || []).map((conflict) => [Number(conflict.pid), conflict]));
  for (const pid of targetPids) {
    const conflict = conflictsByPid.get(Number(pid));
    const name = String(conflict?.name || "").trim().toLowerCase();
    if (
      pid <= 4
      || pid === process.pid
      || conflict?.ownerProjectId
      || PROTECTED_PROCESS_NAMES.has(name)
    ) {
      const owner = conflict?.ownerProjectName || name || ("PID " + pid);
      const error = new Error("拒绝关闭受保护或已归属其他项目的进程：" + owner);
      error.statusCode = 409;
      throw error;
    }
  }
}

function assertSafeProcessTreeTargets(targetPids, processes, currentPid = process.pid) {
  const candidates = normalizePidList(targetPids);
  if (!candidates.length) return;

  const byPid = new Map((processes || []).map((item) => [Number(item?.ProcessId), item]));
  const protectedPids = new Set([Number(currentPid)]);
  let ancestorPid = Number(byPid.get(Number(currentPid))?.ParentProcessId || 0);
  while (Number.isInteger(ancestorPid) && ancestorPid > 0 && !protectedPids.has(ancestorPid)) {
    protectedPids.add(ancestorPid);
    ancestorPid = Number(byPid.get(ancestorPid)?.ParentProcessId || 0);
  }

  for (const pid of candidates) {
    const item = byPid.get(pid);
    const name = String(item?.Name || "").trim().toLowerCase();
    const commandLine = String(item?.CommandLine || "").toLowerCase();
    if (
      pid <= 4
      || protectedPids.has(pid)
      || PROTECTED_PROCESS_NAMES.has(name)
      || commandLine.includes("tray-workbench.ps1")
    ) {
      const error = new Error("Refusing to stop a protected workbench process tree rooted at PID " + pid);
      error.statusCode = 409;
      error.details = { pid, name: name || null };
      throw error;
    }
  }
}

function runExternalControlProcess(project, action, context = {}) {
  const control = project?.externalControl;
  const actionArgs = control?.actions?.[action];
  if (!control?.command || !Array.isArray(actionArgs) || !actionArgs.length) {
    return Promise.resolve({ configured: false });
  }

  const cwd = control.cwd || project.cwd || path.dirname(project.path || control.command);
  const timeoutMs = Number(control.timeoutMs) || 15000;
  const env = {
    ...process.env,
    PROJECT_LAUNCHER_CONTROL_ACTION: action,
    PROJECT_LAUNCHER_CONTROL_CONTEXT: JSON.stringify(normalizeControlContext(context)),
    PROJECT_LAUNCHER_PROJECT_ID: String(project.id || ""),
    PROJECT_LAUNCHER_MANAGED: "1"
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(control.command, [...(control.args || []), ...actionArgs], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const error = new Error(`External control action timed out: ${action}`);
      error.code = "PROJECT_EXTERNAL_CONTROL_TIMEOUT";
      reject(error);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.code = error.code || "PROJECT_EXTERNAL_CONTROL_SPAWN_FAILED";
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal || code !== 0) {
        const detail = redact(stderr || stdout).trim().slice(-2000);
        const error = new Error(
          `External control action failed: ${action} (${signal ? `signal ${signal}` : `exit ${code}`})`
          + (detail ? `: ${detail}` : "")
        );
        error.code = "PROJECT_EXTERNAL_CONTROL_FAILED";
        error.details = { action, exitCode: code, signal: signal || null };
        reject(error);
        return;
      }
      resolve({ configured: true, exitCode: code, stdout: stdout.trim() });
    });
  });
}

function normalizeControlContext(context = {}) {
  return {
    owner: String(context.owner || ""),
    instanceId: String(context.instanceId || ""),
    runId: String(context.runId || ""),
    launcherPid: Number(context.launcherPid) || null,
    processCreatedAt: Number(context.processCreatedAt) || null,
    commandFingerprint: String(context.commandFingerprint || ""),
    errorCode: String(context.errorCode || ""),
    ports: normalizePidList(context.ports),
    pids: normalizePidList(context.pids),
    sources: Array.isArray(context.sources) ? context.sources.map(String) : []
  };
}

function appendBoundedOutput(current, chunk, maxLength = 16384) {
  return (current + String(chunk || "")).slice(-maxLength);
}

function now() {
  return new Date().toISOString();
}

function redact(input) {
  return String(input)
    .replace(/(password|passwd|pwd)\s*[:=]\s*([^\s]+)/gi, "$1=<redacted>")
    .replace(/(token|api[_-]?key|secret)\s*[:=]\s*([^\s]+)/gi, "$1=<redacted>");
}

module.exports = {
  ProjectRunner,
  assertSafeProcessTreeTargets,
  collapseProcessTreePids,
  compactProcessStates,
  createProjectEnvironment,
  createWindowsCommandLine,
  getTrackedAncestorPids,
  killProcessTree,
  resolveWindowsExecutablePath,
  runExternalControlProcess,
  spawnIndependentProcess,
  waitForListeningInstancesStop,
  waitForProjectStop
};
