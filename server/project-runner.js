const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveLogFile } = require("./config");
const { findPortPids, findProjectPids } = require("./status-checker");

const RUNNABLE_TYPES = new Set(["exe", "bat", "cmd"]);
const OPENABLE_TYPES = new Set(["url", "folder", "file"]);

class ProjectRunner {
  constructor() {
    this.processes = new Map();
  }

  getRuntimeState(projectId) {
    const states = this.getProcessStates(projectId);
    if (!states.length) return null;

    const runningStates = states.filter((state) => state.running);
    const latest = states.reduce((current, state) => (
      !current || state.startedAt > current.startedAt ? state : current
    ), null);
    const primary = runningStates[0] || latest;

    return {
      projectId,
      pid: primary?.child?.pid || null,
      pids: runningStates.map((state) => state.child?.pid).filter(Boolean),
      processCount: states.length,
      runningCount: runningStates.length,
      running: runningStates.length > 0,
      startedAt: latest?.startedAt || null,
      exitedAt: latest?.exitedAt || null,
      exitCode: latest?.exitCode,
      signal: latest?.signal || null,
      lastError: latest?.lastError || null
    };
  }

  getProcessStates(projectId) {
    const states = this.processes.get(projectId);
    if (!states) return [];
    return Array.isArray(states) ? states : [states];
  }

  getRunningStates(projectId) {
    return this.getProcessStates(projectId).filter((state) => state.running);
  }

  async startProject(project) {
    this.assertProjectShape(project);

    const runningStates = this.getRunningStates(project.id);
    if (runningStates.length && !project.allowMultiple) {
      return {
        ok: true,
        alreadyRunning: true,
        message: "\u9879\u76ee\u5df2\u7531\u5de5\u4f5c\u53f0\u542f\u52a8",
        runtime: this.getRuntimeState(project.id)
      };
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
      running: true,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      lastError: null
    };

    const states = this.getProcessStates(project.id);
    states.push(state);
    this.processes.set(project.id, states);
    await this.appendLog(project, `[${now()}] start ${project.type}: ${launch.display}\n`);

    child.stdout?.on("data", (chunk) => {
      this.appendLog(project, redact(chunk.toString())).catch(() => {});
    });

    child.stderr?.on("data", (chunk) => {
      this.appendLog(project, redact(chunk.toString())).catch(() => {});
    });

    child.once("error", (error) => {
      state.running = false;
      state.exitedAt = Date.now();
      state.lastError = error.message;
      this.appendLog(project, `[${now()}] process error: ${error.message}\n`).catch(() => {});
    });

    child.once("exit", (code, signal) => {
      state.running = false;
      state.exitedAt = Date.now();
      state.exitCode = code;
      state.signal = signal;
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
    const trackedPids = new Set(runningStates.map((state) => state.child?.pid).filter(Boolean).map(Number));
    const externalPids = await this.findExternalPids(project, trackedPids);

    if (!runningStates.length && !externalPids.length) {
      throw new Error("\u5f53\u524d\u6ca1\u6709\u53ef\u505c\u6b62\u7684\u8fd0\u884c\u4e2d\u8fdb\u7a0b");
    }

    if (externalPids.length && !project.allowStopExternal) {
      throw new Error(`\u68c0\u6d4b\u5230\u5916\u90e8\u8fdb\u7a0b PID: ${externalPids.join(", ")}\uff0c\u9700\u5728\u8bbe\u7f6e\u4e2d\u5f00\u542f\u5141\u8bb8\u505c\u6b62\u5916\u90e8\u8fdb\u7a0b`);
    }

    await this.appendLog(project, `[${now()}] stop requested for ${runningStates.length} tracked process(es), ${externalPids.length} external process(es)\n`);

    for (const state of runningStates) {
      if (!state.child?.pid) continue;
      await killProcessTree(state.child.pid);
      state.running = false;
      state.exitedAt = Date.now();
    }

    for (const pid of externalPids) {
      await killProcessTree(pid);
      await this.appendLog(project, `[${now()}] stopped external port process: pid=${pid}\n`);
    }

    return {
      ok: true,
      message: externalPids.length
        ? `\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001\uff0c\u5305\u542b ${externalPids.length} \u4e2a\u5916\u90e8\u8fdb\u7a0b`
        : (runningStates.length > 1 ? `\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001\uff0c\u5171 ${runningStates.length} \u4e2a\u5b9e\u4f8b` : "\u505c\u6b62\u547d\u4ee4\u5df2\u53d1\u9001"),
      runtime: this.getRuntimeState(project.id)
    };
  }

  async findExternalPids(project, trackedPids) {
    const pids = new Set();

    if (Number.isInteger(project.port)) {
      for (const pid of await findPortPids(project.port)) {
        pids.add(Number(pid));
      }
    }

    if (project.detectExternal !== false) {
      for (const pid of await findProjectPids(project)) {
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
    await openTarget(target, project.type === "folder" ? "folder" : "file");
    await this.appendLog(project, `[${now()}] open path: ${target}\n`);
    return { ok: true, message: "已打开路径" };
  }

  async openFolder(project) {
    const target = project.cwd || (project.type === "folder" ? project.path : path.dirname(project.path || ""));
    if (!target) {
      throw new Error("项目未配置可打开的目录");
    }
    assertPathExists(target);
    const stats = fs.statSync(target);
    const folder = stats.isDirectory() ? target : path.dirname(target);
    await openTarget(folder, "folder");
    await this.appendLog(project, `[${now()}] open folder: ${folder}\n`);
    return { ok: true, message: "已打开目录" };
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

  createLaunchSpec(project) {
    const cwd = project.cwd ? path.resolve(project.cwd) : process.cwd();
    assertPathExists(cwd);

    if (project.type === "exe") {
      if (!project.path) throw new Error("exe 项目缺少 path");
      assertPathExists(project.path);
      return {
        command: project.path,
        args: normalizeArgs(project.args),
        cwd,
        shell: false,
        display: project.path
      };
    }

    if (project.type === "bat") {
      if (!project.path) throw new Error("bat \u9879\u76ee\u7f3a\u5c11 path");
      assertPathExists(project.path);
      const batPath = path.resolve(project.path);
      const batCwd = project.cwd ? cwd : path.dirname(batPath);
      const commandLine = [quoteCmdArg(batPath), ...normalizeArgs(project.args).map(quoteCmdArg)].join(" ");
      return {
        command: "cmd.exe",
        args: ["/d", "/k", commandLine],
        cwd: batCwd,
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        display: project.path
      };
    }

    if (project.type === "cmd") {
      if (!project.command) throw new Error("cmd 项目缺少 command");
      return {
        command: project.command,
        args: [],
        cwd,
        shell: true,
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
    return spawnDetached("explorer.exe", ["/n,", resolvedTarget], { windowsHide: false });
  }

  if (kind === "file") {
    return spawnDetached("cmd.exe", ["/d", "/s", "/c", "start", "", resolvedTarget], { windowsHide: false });
  }

  return spawnDetached("cmd.exe", ["/d", "/s", "/c", "start", "", target], { windowsHide: false });
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

function killProcessTree(pid) {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true
      });
      child.once("exit", (code) => {
        code === 0 ? resolve() : reject(new Error(`taskkill failed with exit code ${code}`));
      });
      child.once("error", reject);
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
      resolve();
    } catch (error) {
      reject(error);
    }
  });
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
  ProjectRunner
};
