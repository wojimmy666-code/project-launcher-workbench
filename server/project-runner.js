const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");
const { ROOT_DIR, resolveLogFile } = require("./config");
const { resolveProjectPort } = require("./project-port");
const {
  findPortPids,
  findProjectPids,
  getProcessMemoryInfo,
  invalidateProcessSnapshot
} = require("./status-checker");

const RUNNABLE_TYPES = new Set(["exe", "bat", "cmd"]);
const OPENABLE_TYPES = new Set(["url", "folder", "file"]);
const RUNTIME_STATE_PATH = path.join(ROOT_DIR, "config", "runtime-state.json");
const WINDOWS_FOLDER_OPENER_PATH = path.join(ROOT_DIR, "scripts", "open-folder.ps1");

class ProjectRunner {
  constructor() {
    this.processes = new Map();
    this.loadRuntimeState();
  }

  getRuntimeState(projectId) {
    const states = this.getProcessStates(projectId);
    if (!states.length) return null;

    const runningStates = states.filter((state) => state.running);
    const latest = states.reduce((current, state) => (
      !current || state.startedAt > current.startedAt ? state : current
    ), null);
    const primary = runningStates[0] || latest;
    const rootPids = runningStates.map(getStatePid).filter(Boolean);
    const trackedPids = getTrackedProcessTreePids(rootPids);

    return {
      projectId,
      pid: getStatePid(primary),
      pids: trackedPids,
      rootPids,
      processCount: states.length,
      runningCount: runningStates.length,
      running: runningStates.length > 0,
      startedAt: latest?.startedAt || null,
      exitedAt: latest?.exitedAt || null,
      exitCode: latest?.exitCode,
      signal: latest?.signal || null,
      lastError: latest?.lastError || null,
      stoppedByUser: Boolean(latest?.stoppedByUser)
    };
  }

  getProcessStates(projectId) {
    const states = this.processes.get(projectId);
    if (!states) return [];

    const list = Array.isArray(states) ? states : [states];
    let changed = false;
    for (const state of list) {
      if (state.running && !isPidAlive(getStatePid(state))) {
        state.running = false;
        state.exitedAt = state.exitedAt || Date.now();
        state.exitCode = state.exitCode ?? null;
        changed = true;
      }
    }

    if (changed) {
      this.saveRuntimeState();
    }

    return list;
  }

  getRunningStates(projectId) {
    return this.getProcessStates(projectId).filter((state) => state.running);
  }

  getTrackedProcessTreePids(rootPids) {
    return getTrackedProcessTreePids(rootPids);
  }

  getIndependentProcessRoots(pids) {
    return getIndependentProcessRoots(pids);
  }

  killProcessTree(pid) {
    return killProcessTree(pid);
  }

  findProjectPids(project, options) {
    return findProjectPids(project, options);
  }

  async startProject(project) {
    this.assertProjectShape(project);

    const runningStates = this.getRunningStates(project.id);
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
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      shell: launch.shell,
      detached: Boolean(launch.detached),
      stdio: launch.stdio || "pipe",
      windowsHide: Boolean(launch.windowsHide),
      env: process.env
    });

    const state = {
      child,
      pid: child.pid || null,
      running: true,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      lastError: null,
      stoppedByUser: false
    };

    const states = this.getProcessStates(project.id);
    states.push(state);
    this.processes.set(project.id, states);
    this.saveRuntimeState();
    await this.appendLog(project, `[${now()}] start ${project.type}: ${launch.display}\n`);

    child.stdout?.on("data", (chunk) => {
      this.appendLog(project, redact(chunk.toString())).catch(() => {});
    });

    child.stderr?.on("data", (chunk) => {
      this.appendLog(project, redact(chunk.toString())).catch(() => {});
    });

    child.once("error", (error) => {
      invalidateProcessSnapshot();
      state.running = false;
      state.exitedAt = Date.now();
      state.lastError = error.message;
      state.stoppedByUser = false;
      this.saveRuntimeState();
      this.appendLog(project, `[${now()}] process error: ${error.message}\n`).catch(() => {});
    });

    child.once("exit", (code, signal) => {
      invalidateProcessSnapshot();
      state.running = false;
      state.exitedAt = Date.now();
      state.exitCode = code;
      state.signal = signal;
      this.saveRuntimeState();
      this.appendLog(project, `[${now()}] process exited: code=${code} signal=${signal || ""}\n`).catch(() => {});
    });

    return {
      ok: true,
      message: project.allowMultiple && runningStates.length ? "\u5df2\u542f\u52a8\u65b0\u7684\u9879\u76ee\u5b9e\u4f8b" : "\u542f\u52a8\u547d\u4ee4\u5df2\u53d1\u9001",
      runtime: this.getRuntimeState(project.id)
    };
  }

  async stopProject(project) {
    const runningStates = this.getRunningStates(project.id);
    const rootPids = runningStates.map(getStatePid).filter(Boolean).map(Number);
    const trackedPids = new Set(this.getTrackedProcessTreePids(rootPids));
    const externalPids = await this.findExternalPids(project, trackedPids);

    if (!runningStates.length && !externalPids.length) {
      throw new Error("\u5f53\u524d\u6ca1\u6709\u53ef\u505c\u6b62\u7684\u8fd0\u884c\u4e2d\u8fdb\u7a0b");
    }

    if (externalPids.length && !project.allowStopExternal) {
      throw new Error("\u68c0\u6d4b\u5230\u5916\u90e8\u8fdb\u7a0b PID: " + externalPids.join(", ") + "\uff0c\u9700\u5728\u8bbe\u7f6e\u4e2d\u5f00\u542f\u5141\u8bb8\u505c\u6b62\u5916\u90e8\u8fdb\u7a0b");
    }

    await this.appendLog(project, "[" + now() + "] stop requested for " + runningStates.length + " tracked process(es), " + externalPids.length + " external process(es)\n");
    const killTargets = this.getIndependentProcessRoots([...rootPids, ...externalPids]);
    for (const state of runningStates) {
      state.stoppedByUser = true;
    }
    this.saveRuntimeState();
    let stopCompleted = false;

    try {
      for (const pid of killTargets) {
        await this.killProcessTree(pid);
      }
      stopCompleted = true;
    } finally {
      invalidateProcessSnapshot();
      const stoppedAt = Date.now();
      for (const state of runningStates) {
        const pid = getStatePid(state);
        if (!pid || !isPidAlive(pid)) {
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
        ? "\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001\uff0c\u5305\u542b " + externalPids.length + " \u4e2a\u5916\u90e8\u8fdb\u7a0b"
        : (runningStates.length > 1 ? "\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001\uff0c\u5171 " + runningStates.length + " \u4e2a\u5b9e\u4f8b" : "\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001"),
      runtime: this.getRuntimeState(project.id)
    };
  }

  async findExternalPids(project, trackedPids) {
    const pids = new Set();
    const projectPort = resolveProjectPort(project);

    if (Number.isInteger(projectPort)) {
      for (const pid of await findPortPids(projectPort)) {
        pids.add(Number(pid));
      }
    }

    if (project.detectExternal !== false) {
      for (const pid of await this.findProjectPids(project, { fresh: true })) {
        pids.add(Number(pid));
      }
    }

    return [...pids].filter((pid) => Number.isInteger(pid) && pid > 0 && !trackedPids.has(pid) && pid !== process.pid);
  }
  async restartProject(project) {
    if (this.getRunningStates(project.id).length) {
      await this.stopProject(project);
      await delay(800);
    }
    return this.startProject(project);
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

    await openCodexPowerShell(codexCwd);
    await this.appendLog(project, `[${now()}] open codex: ${codexCwd}\n`);
    return { ok: true, message: "已新开 Codex 窗口" };
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
    const data = readRuntimeStateFile();
    for (const entry of data.projects || []) {
      if (!entry?.projectId || !Array.isArray(entry.states)) continue;
      const states = entry.states
        .map(deserializeRuntimeState)
        .filter(Boolean);
      if (states.length) {
        this.processes.set(entry.projectId, states);
      }
    }
  }

  saveRuntimeState() {
    writeRuntimeStateFile({
      version: 1,
      updatedAt: now(),
      projects: [...this.processes.entries()].map(([projectId, states]) => ({
        projectId,
        states: (Array.isArray(states) ? states : [states]).map(serializeRuntimeState)
      })).filter((entry) => entry.states.length)
    });
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
        stdio: hideConsole ? ["ignore", "pipe", "pipe"] : "pipe",
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
        detached: !hideConsole,
        stdio: hideConsole ? ["ignore", "pipe", "pipe"] : "ignore",
        windowsHide: hideConsole,
        display: project.path
      };
    }

    if (project.type === "cmd") {
      if (!project.command) throw new Error("cmd 项目缺少 command");
      const hideConsole = Boolean(project.hideConsole);
      return {
        command: project.command,
        args: [],
        cwd,
        shell: true,
        stdio: hideConsole ? ["ignore", "pipe", "pipe"] : "pipe",
        windowsHide: hideConsole,
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

function serializeRuntimeState(state) {
  const pid = getStatePid(state);
  if (!pid) return null;
  return {
    pid,
    running: Boolean(state.running && isPidAlive(pid)),
    startedAt: Number(state.startedAt || 0) || null,
    exitedAt: Number(state.exitedAt || 0) || null,
    exitCode: state.exitCode ?? null,
    signal: state.signal || null,
    lastError: state.lastError || null,
    stoppedByUser: Boolean(state.stoppedByUser)
  };
}

function deserializeRuntimeState(input) {
  const pid = Number(input?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const alive = isPidAlive(pid);
  return {
    pid,
    child: null,
    running: Boolean(input.running && alive),
    startedAt: Number(input.startedAt || 0) || null,
    exitedAt: alive ? (Number(input.exitedAt || 0) || null) : (Number(input.exitedAt || 0) || Date.now()),
    exitCode: input.exitCode ?? null,
    signal: input.signal || null,
    lastError: input.lastError || null,
    stoppedByUser: Boolean(input.stoppedByUser),
    restored: true
  };
}

function readRuntimeStateFile() {
  try {
    if (!fs.existsSync(RUNTIME_STATE_PATH)) return { projects: [] };
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { projects: [] };
  } catch {
    return { projects: [] };
  }
}

function writeRuntimeStateFile(data) {
  const normalized = {
    ...data,
    projects: (data.projects || []).map((entry) => ({
      ...entry,
      states: (entry.states || []).filter(Boolean)
    })).filter((entry) => entry.states.length)
  };

  fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
  const tempPath = `${RUNTIME_STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, RUNTIME_STATE_PATH);
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map(String) : [];
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

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      ...options
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
          child.unref();
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
        child.unref();
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

function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

async function killProcessTree(pid) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0 || !isPidAlive(targetPid)) return;

  if (process.platform === "win32") {
    const result = await runTaskkill(targetPid);
    if (result.code === 0 || await waitForPidExit(targetPid, 750)) return;

    const detail = result.output ? ": " + result.output : "";
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
  killProcessTree
};
