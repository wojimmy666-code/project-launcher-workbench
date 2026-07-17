const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { ROOT_DIR, resolveLogFile } = require("./config");
const { resolveProjectPort } = require("./project-port");
const {
  classifyProjectPids,
  findPortPids,
  findProjectPids,
  getProcessIdentity,
  getProcessMemoryInfo,
  invalidateProcessSnapshot,
  isPortOpen,
  processIdentityMatches
} = require("./status-checker");

const RUNNABLE_TYPES = new Set(["exe", "bat", "cmd"]);
const OPENABLE_TYPES = new Set(["url", "folder", "file"]);
const RUNTIME_STATE_PATH = path.join(ROOT_DIR, "config", "runtime-state.json");
const WINDOWS_FOLDER_OPENER_PATH = path.join(ROOT_DIR, "scripts", "open-folder.ps1");
const CODEX_DESKTOP_OPENER_PATH = path.join(ROOT_DIR, "scripts", "open-codex-app.ps1");
const STOP_SETTLE_TIMEOUT_MS = 5000;
const STOP_SETTLE_POLL_INTERVAL_MS = 100;
const TASKKILL_EXIT_TIMEOUT_MS = 1500;
const SERVICE_CAPTURE_WINDOW_MS = 60 * 1000;
const PROCESS_START_GRACE_MS = 5000;
const MANAGED_PROCESS_CAPTURE_DELAYS_MS = [100, 500, 1500, 3000, 8000, 15000];
const PROCESS_IDENTITY_RETRY_DELAYS_MS = [0, 50, 150, 300, 500];
let codexDesktopLaunchPending = null;

class ProjectRunner {
  constructor(options = {}) {
    this.processes = new Map();
    this.runtimeStatePath = options.runtimeStatePath || RUNTIME_STATE_PATH;
    this.spawnProcess = options.spawnProcess || spawn;
    if (options.loadRuntimeState !== false) {
      this.loadRuntimeState();
    }
  }

  getRuntimeState(projectId) {
    const states = this.getProcessStates(projectId);
    if (!states.length) return null;

    const runningStates = states.filter((state) => state.running);
    const stopping = states.some((state) => state.stopping);
    const latest = states.reduce((current, state) => (
      !current || state.startedAt > current.startedAt ? state : current
    ), null);
    const primary = runningStates[0] || latest;
    const rootPids = [...new Set(runningStates.flatMap((state) => this.getLiveStatePids(state)))];
    const trackedPids = this.getTrackedProcessTreePids(rootPids);
    const primaryPid = this.getLiveStatePids(primary)[0] || getStatePid(primary);
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
      running: runningStates.length > 0,
      stopping,
      source: primary?.source || "managed",
      adoptedAt: primary?.adoptedAt || null,
      startedAt: latest?.startedAt || null,
      exitedAt: latest?.exitedAt || null,
      exitCode: latest?.exitCode,
      signal: latest?.signal || null,
      lastError: latest?.lastError || null,
      stoppedByUser: Boolean(latest?.stoppedByUser),
      instances: runningStates.map((state) => {
        const livePids = this.getLiveStatePids(state);
        return {
          instanceId: state.instanceId || null,
          pid: livePids[0] || getStatePid(state),
          pids: this.getTrackedProcessTreePids(livePids),
          servicePids: normalizePidList(state.servicePids).filter((pid) => livePids.includes(pid)),
          source: state.source || "managed",
          startedAt: state.startedAt || null,
          adoptedAt: state.adoptedAt || null,
          stopping: Boolean(state.stopping)
        };
      })
    };
  }

  getProcessStates(projectId) {
    const states = this.processes.get(projectId);
    if (!states) return [];

    const list = Array.isArray(states) ? states : [states];
    let changed = false;
    const nowMs = Date.now();
    for (const state of list) {
      const alive = this.isStateAlive(state);
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

  getRunningStates(projectId) {
    return this.getProcessStates(projectId).filter((state) => state.running);
  }

  clearInactiveRuntimeState(projectId) {
    const states = this.getProcessStates(projectId);
    if (!states.length || states.some((state) => state.running)) return false;
    this.processes.delete(projectId);
    this.saveRuntimeState();
    return true;
  }

  getTrackedProcessTreePids(rootPids) {
    return getTrackedProcessTreePids(rootPids);
  }

  getIndependentProcessRoots(pids) {
    return getIndependentProcessRoots(pids);
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

  captureStateProcessTree(state, options = {}) {
    if (!state || state.stoppedByUser) return false;

    const liveRoots = this.getLiveStatePids(state);
    const rootPid = getStatePid(state);
    const withinCaptureWindow = Date.now() - Number(state.startedAt || 0) <= SERVICE_CAPTURE_WINDOW_MS;
    // A just-exited BAT shell can still be the recorded parent of its live
    // Python child. Use that root only during the bounded capture window.
    const roots = liveRoots.length
      ? liveRoots
      : (withinCaptureWindow && rootPid ? [rootPid] : []);
    if (!roots.length) return false;

    const memory = this.getProcessMemoryInfo(roots, {
      trackHistory: false,
      fresh: Boolean(options.fresh)
    });
    const livePids = normalizePidList(memory?.pids);
    if (!livePids.length) return false;

    const knownServicePids = new Set(normalizePidList(state.servicePids));
    const identitiesByPid = new Map(
      normalizeProcessIdentities(state.processIdentities)
        .map((identity) => [identity.pid, identity])
    );
    let changed = false;

    for (const pid of livePids) {
      if (pid !== rootPid && !knownServicePids.has(pid)) {
        knownServicePids.add(pid);
        changed = true;
      }
      if (!identitiesByPid.has(pid)) {
        // The process-tree snapshot above already refreshed the shared cache.
        const identity = this.getProcessIdentity(pid);
        if (identity) {
          identitiesByPid.set(pid, identity);
          changed = true;
        }
      }
    }

    if (!state.running) {
      state.running = true;
      state.exitedAt = null;
      state.exitCode = null;
      state.signal = null;
      changed = true;
    }
    if (state.stopping) {
      state.stopping = false;
      changed = true;
    }

    state.servicePids = [...knownServicePids];
    state.processIdentities = [...identitiesByPid.values()];
    state.identityRequired = true;
    return changed;
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
      this.saveRuntimeState();
    }
    return changed;
  }

  reconcileProjectProcesses(project) {
    if (!project?.id) return false;
    return this.captureManagedProcessTrees(project.id);
  }

  scheduleManagedProcessCapture(projectId, state) {
    for (const captureDelay of MANAGED_PROCESS_CAPTURE_DELAYS_MS) {
      const timer = setTimeout(() => {
        const stored = this.processes.get(projectId);
        const states = Array.isArray(stored) ? stored : (stored ? [stored] : []);
        if (!states.includes(state) || state.stoppedByUser) return;
        if (this.captureStateProcessTree(state, { fresh: true })) {
          this.processes.set(projectId, compactProcessStates(states));
          this.saveRuntimeState();
        }
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

  isStateAlive(state) {
    return this.getLiveStatePids(state).length > 0;
  }

  isPersistedStateAlive(state) {
    const strictState = { ...state, identityRequired: true };
    const pids = this.getStateTrackedPids(strictState);
    return pids.some((pid) => this.isTrackedPidAlive(pid, strictState));
  }

  killProcessTree(pid) {
    return killProcessTree(pid);
  }

  spawnIndependentProcess(command, args, options) {
    return spawnIndependentProcess(command, args, options, this.spawnProcess);
  }

  openProjectOutput(project) {
    const file = resolveLogFile(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a");
    let closed = false;
    return {
      stdio: ["ignore", fd, fd],
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      }
    };
  }

  launchProjectProcess(project, launch, instanceId) {
    const output = this.openProjectOutput(project);
    try {
      return this.spawnIndependentProcess(launch.command, launch.args, {
        cwd: launch.cwd,
        shell: false,
        stdio: output.stdio,
        windowsHide: Boolean(launch.windowsHide),
        env: createProjectEnvironment(project, process.env, instanceId)
      });
    } finally {
      output.close();
    }
  }

  async getProcessIdentityAfterSpawn(pid) {
    for (const waitMs of PROCESS_IDENTITY_RETRY_DELAYS_MS) {
      if (waitMs) await delay(waitMs);
      const identity = this.getProcessIdentity(pid, { fresh: true });
      if (identity) return identity;
    }
    return null;
  }

  findProjectPids(project, options) {
    return findProjectPids(project, options);
  }

  findPortPids(port) {
    return findPortPids(port);
  }

  classifyProjectPids(project, pids, options) {
    return classifyProjectPids(project, pids, options);
  }

  isPortOpen(host, port) {
    return isPortOpen(host, port);
  }

  async startProject(project, options = {}) {
    this.assertProjectShape(project);

    const runningStates = this.getRunningStates(project.id);
    const trackedPids = new Set(this.getTrackedProcessTreePids(
      runningStates.flatMap((state) => this.getLiveStatePids(state))
    ));
    if (RUNNABLE_TYPES.has(project.type)) {
      const portConflict = await this.findPortConflicts(project, trackedPids, options);
      if (portConflict.conflictPids.length || portConflict.unverified) {
        const owner = portConflict.conflicts[0];
        const ownerText = owner?.ownerProjectName || owner?.name || "未知进程";
        const pidText = owner?.pid ? `（PID ${owner.pid}）` : "";
        throw new Error(`端口 ${portConflict.port} 已被 ${ownerText}${pidText}占用，无法启动`);
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

      const externalPids = await this.findExternalPids(project, new Set());
      if (externalPids.length) {
        const projectPort = resolveProjectPort(project);
        if (
          Number.isInteger(projectPort)
          && !await this.isPortOpen(project.host || "127.0.0.1", projectPort)
        ) {
          const visiblePids = externalPids.slice(0, 8);
          const pidText = visiblePids.join(", ")
            + (externalPids.length > visiblePids.length ? " 等 " + externalPids.length + " 个" : "");
          const message = "未执行启动：检测到项目相关外部进程 PID " + pidText
            + "，但目标端口 " + projectPort + " 未监听；这些进程不代表目标服务已启动";
          await this.appendLog(project, "[" + now() + "] start blocked: related external pid(s) "
            + externalPids.join(", ") + ", target port " + projectPort + " is not listening\n");
          const error = new Error(message);
          error.statusCode = 409;
          error.code = "PROJECT_TARGET_PORT_NOT_LISTENING";
          error.details = {
            code: error.code,
            port: projectPort,
            externalPids
          };
          throw error;
        }

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
    const instanceId = randomUUID();
    const startedAt = Date.now();
    await this.appendLog(project, `[${now()}] start ${project.type}: ${launch.display} instance=${instanceId}\n`);

    let child;
    try {
      child = this.launchProjectProcess(project, launch, instanceId);
    } catch (error) {
      await this.appendLog(project, `[${now()}] process spawn failed: ${error.message}\n`);
      throw error;
    }

    const state = {
      instanceId,
      child: null,
      pid: child.pid || null,
      servicePids: [],
      processIdentities: [],
      identityRequired: true,
      source: "managed",
      adoptedAt: null,
      running: true,
      startedAt,
      launchConfirmedAt: null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      lastError: null,
      stoppedByUser: false,
      stopping: false
    };

    let launchConfirmed = false;
    const spawnReady = new Promise((resolve, reject) => {
      child.once("spawn", () => {
        launchConfirmed = true;
        state.pid = child.pid || state.pid;
        state.launchConfirmedAt = Date.now();
        resolve();
      });

      child.once("error", (error) => {
        invalidateProcessSnapshot();
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
      this.captureStateProcessTree(state, { fresh: true });
      state.exitedAt = Date.now();
      state.exitCode = code;
      state.signal = signal;
      state.running = this.isStateAlive(state);
      this.compactProcessStates(project.id);
      this.saveRuntimeState();
      this.appendLog(project, `[${now()}] process exited: code=${code} signal=${signal || ""}\n`).catch(() => {});
    });

    try {
      await spawnReady;
    } catch (error) {
      await this.appendLog(project, `[${now()}] process spawn failed: ${error.message}\n`);
      throw error;
    }

    if (!Number.isInteger(Number(state.pid)) || Number(state.pid) <= 0) {
      const error = new Error("The independent process started without a valid PID");
      await this.appendLog(project, `[${now()}] process spawn failed: ${error.message}\n`);
      throw error;
    }

    const rootIdentity = await this.getProcessIdentityAfterSpawn(state.pid);
    if (rootIdentity) state.processIdentities.push(rootIdentity);

    const states = this.getProcessStates(project.id);
    states.push(state);
    this.processes.set(project.id, states);
    this.compactProcessStates(project.id);
    this.saveRuntimeState();
    this.scheduleManagedProcessCapture(project.id, state);

    return {
      ok: true,
      message: project.allowMultiple && runningStates.length ? "\u5df2\u542f\u52a8\u65b0\u7684\u9879\u76ee\u5b9e\u4f8b" : "\u542f\u52a8\u547d\u4ee4\u5df2\u53d1\u9001",
      runtime: this.getRuntimeState(project.id)
    };
  }

  async stopProject(project) {
    invalidateProcessSnapshot();
    const candidateStates = this.getRunningStates(project.id);
    let runningStates = [];
    const verifiedPids = [];
    let discardedStaleState = false;
    for (const state of candidateStates) {
      const livePids = this.getLiveStatePids(state);
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
    let trackedPids = new Set(this.getTrackedProcessTreePids(rootPids));
    const externalPids = await this.findExternalPids(project, trackedPids);

    const finalVerifiedPids = [];
    runningStates = runningStates.filter((state) => {
      const livePids = this.getLiveStatePids(state);
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
    trackedPids = new Set(this.getTrackedProcessTreePids(rootPids));
    if (discardedStaleState) this.saveRuntimeState();

    if (!runningStates.length && !externalPids.length) {
      throw new Error("\u5f53\u524d\u6ca1\u6709\u53ef\u505c\u6b62\u7684\u8fd0\u884c\u4e2d\u8fdb\u7a0b");
    }

    if (externalPids.length && !project.allowStopExternal) {
      throw new Error("\u68c0\u6d4b\u5230\u5916\u90e8\u8fdb\u7a0b PID: " + externalPids.join(", ") + "\uff0c\u9700\u5728\u8bbe\u7f6e\u4e2d\u5f00\u542f\u5141\u8bb8\u505c\u6b62\u5916\u90e8\u8fdb\u7a0b");
    }

    await this.appendLog(project, "[" + now() + "] stop requested for " + runningStates.length + " tracked process(es), " + externalPids.length + " external process(es)\n");
    const allTargetPids = [...new Set([...trackedPids, ...externalPids])];
    const killTargets = this.getIndependentProcessRoots([...rootPids, ...externalPids]);
    for (const state of runningStates) {
      state.stoppedByUser = true;
      state.stopping = true;
    }
    this.saveRuntimeState();
    let stopCompleted = false;

    try {
      for (const pid of killTargets) {
        await this.killProcessTree(pid);
      }

      const settled = await this.waitForProjectStop(project, allTargetPids);
      if (!settled) {
        throw new Error("\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001\uff0c\u4f46\u8fdb\u7a0b\u6216\u7aef\u53e3\u5728 5 \u79d2\u5185\u672a\u5b8c\u5168\u9000\u51fa");
      }
      stopCompleted = true;
    } finally {
      invalidateProcessSnapshot();
      const stoppedAt = Date.now();
      for (const state of runningStates) {
        state.stopping = false;
        if (!this.isStateAlive(state)) {
          state.running = false;
          state.exitedAt = stoppedAt;
        } else {
          state.stoppedByUser = false;
        }
      }
      if (stopCompleted) {
        const latestState = this.getProcessStates(project.id).reduce((current, state) => (
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
      runtime: this.getRuntimeState(project.id)
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

        const ownership = this.classifyProjectPids(project, portPids, {
          runtimePids: targetPids,
          fresh: true
        });
        return ownership.ownedPids.length > 0;
      }
    });
  }

  async findPortConflicts(project, trackedPids = new Set(), options = {}) {
    const projectPort = resolveProjectPort(project);
    if (!Number.isInteger(projectPort)) {
      return { port: null, conflictPids: [], conflicts: [], unverified: false };
    }

    const open = await this.isPortOpen(project.host || "127.0.0.1", projectPort);
    if (!open) {
      return { port: projectPort, conflictPids: [], conflicts: [], unverified: false };
    }

    const portPids = await this.findPortPids(projectPort);
    const ownership = this.classifyProjectPids(project, portPids, {
      runtimePids: trackedPids,
      knownProjects: options.projects,
      fresh: true
    });
    return {
      port: projectPort,
      conflictPids: ownership.foreignPids,
      conflicts: ownership.conflicts,
      unverified: portPids.length === 0 && trackedPids.size === 0
    };
  }

  async findExternalPids(project, trackedPids) {
    const pids = new Set();
    const projectPort = resolveProjectPort(project);

    if (Number.isInteger(projectPort)) {
      const portPids = await this.findPortPids(projectPort);
      const ownership = this.classifyProjectPids(project, portPids, {
        runtimePids: trackedPids,
        fresh: true
      });
      for (const pid of ownership.ownedPids) {
        pids.add(Number(pid));
      }
    }

    if (project.detectExternal !== false) {
      for (const pid of await this.findProjectPids(project, { fresh: true })) {
        pids.add(Number(pid));
      }
    }

    const candidates = [...pids].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    const memory = trackedPids.size && candidates.length
      ? this.getProcessMemoryInfo([...candidates, ...trackedPids], { trackHistory: false })
      : null;
    const managedLineagePids = getTrackedAncestorPids(candidates, trackedPids, memory?.processes || []);
    return candidates.filter((pid) => !trackedPids.has(pid) && !managedLineagePids.has(pid));
  }

  trackServicePids(projectId, pids) {
    const servicePids = normalizePidList(pids);
    if (!servicePids.length) return false;

    const states = this.getProcessStates(projectId);
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
      const identity = this.getProcessIdentity(pid, { fresh: true });
      if (!identity) continue;
      knownPids.add(pid);
      identities.push(identity);
      changed = true;
    }

    if (!changed) return false;
    target.servicePids = [...knownPids];
    target.processIdentities = identities;
    target.identityRequired = true;
    target.running = true;
    target.exitedAt = null;
    target.stoppedByUser = false;
    target.source = target.source || "managed";
    this.processes.set(projectId, compactProcessStates(states));
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

    const adoptedAt = Date.now();
    const state = {
      instanceId: randomUUID(),
      child: null,
      pid,
      servicePids: [pid],
      processIdentities: [identity],
      identityRequired: true,
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
    if (this.getRunningStates(project.id).length) {
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
      version: 2,
      updatedAt: now(),
      projects: [...this.processes.entries()].map(([projectId, states]) => ({
        projectId,
        states: (Array.isArray(states) ? states : [states]).map((state) => serializeRuntimeState(
          state,
          (candidate) => this.isPersistedStateAlive(candidate)
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
      const hideConsole = Boolean(project.hideConsole);
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
      const commandLine = [quoteCmdArg(batPath), ...normalizeArgs(project.args).map(quoteCmdArg)].join(" ");
      const hideConsole = Boolean(project.hideConsole);
      return {
        command: "cmd.exe",
        args: ["/d", hideConsole ? "/c" : "/k", commandLine],
        cwd: batCwd,
        shell: false,
        windowsHide: hideConsole,
        display: project.path
      };
    }

    if (project.type === "cmd") {
      if (!project.command) throw new Error("cmd 项目缺少 command");
      const hideConsole = Boolean(project.hideConsole);
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

function normalizeProcessIdentities(values) {
  return (Array.isArray(values) ? values : []).map((identity) => ({
    pid: Number(identity?.pid || 0),
    name: String(identity?.name || ""),
    createdAt: Number(identity?.createdAt || 0) || null,
    executablePath: String(identity?.executablePath || ""),
    commandFingerprint: String(identity?.commandFingerprint || "") || null
  })).filter((identity) => Number.isInteger(identity.pid) && identity.pid > 0);
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

function getTrackedProcessTreePids(rootPids) {
  const roots = [...new Set((rootPids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!roots.length) return [];

  const memory = getProcessMemoryInfo(roots);
  const descendants = Array.isArray(memory?.pids) ? memory.pids.map(Number) : [];
  return [...new Set([...roots, ...descendants].filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function getIndependentProcessRoots(pids) {
  const candidates = [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (candidates.length < 2) return candidates;

  const memory = getProcessMemoryInfo(candidates);
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
    if (state.running) {
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
    source: state.source === "adopted" ? "adopted" : "managed",
    adoptedAt: Number(state.adoptedAt || 0) || null,
    running: Boolean(state.running && checkAlive(state)),
    startedAt: Number(state.startedAt || 0) || null,
    launchConfirmedAt: Number(state.launchConfirmedAt || 0) || null,
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
    source: input.source === "adopted" ? "adopted" : "managed",
    adoptedAt: Number(input.adoptedAt || 0) || null,
    running: alive,
    startedAt: Number(input.startedAt || 0) || null,
    launchConfirmedAt: Number(input.launchConfirmedAt || 0) || null,
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

function createProjectEnvironment(project, baseEnv = process.env, instanceId = "") {
  const env = { ...baseEnv };
  const projectPort = resolveProjectPort(project);
  if (Number.isInteger(projectPort)) {
    env.PORT = String(projectPort);
  }
  env.PROJECT_LAUNCHER_PROJECT_ID = String(project?.id || "");
  env.PROJECT_LAUNCHER_INSTANCE_ID = String(instanceId || "");
  return env;
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
  collapseProcessTreePids,
  compactProcessStates,
  createProjectEnvironment,
  getTrackedAncestorPids,
  killProcessTree,
  spawnIndependentProcess,
  waitForProjectStop
};
