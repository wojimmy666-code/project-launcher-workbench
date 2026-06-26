const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveLogFile } = require("./config");

const RUNNABLE_TYPES = new Set(["exe", "bat", "cmd"]);
const OPENABLE_TYPES = new Set(["url", "folder", "file"]);

class ProjectRunner {
  constructor() {
    this.processes = new Map();
  }

  getRuntimeState(projectId) {
    const state = this.processes.get(projectId);
    if (!state) return null;

    return {
      projectId,
      pid: state.child?.pid || null,
      running: Boolean(state.running),
      startedAt: state.startedAt,
      exitedAt: state.exitedAt || null,
      exitCode: state.exitCode,
      signal: state.signal || null,
      lastError: state.lastError || null
    };
  }

  async startProject(project) {
    this.assertProjectShape(project);

    const existing = this.processes.get(project.id);
    if (existing?.running) {
      return {
        ok: true,
        alreadyRunning: true,
        message: "项目已由工作台启动",
        runtime: this.getRuntimeState(project.id)
      };
    }

    if (OPENABLE_TYPES.has(project.type)) {
      await this.openProject(project);
      await this.appendLog(project, `[${now()}] opened ${project.type}\n`);
      return {
        ok: true,
        message: "已打开项目",
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
      windowsHide: false,
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

    this.processes.set(project.id, state);
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
      message: "启动命令已发送",
      runtime: this.getRuntimeState(project.id)
    };
  }

  async stopProject(project) {
    const state = this.processes.get(project.id);
    if (!state?.running || !state.child?.pid) {
      throw new Error("当前没有由工作台启动的运行中进程");
    }

    await this.appendLog(project, `[${now()}] stop requested\n`);
    await killProcessTree(state.child.pid);
    state.running = false;
    state.exitedAt = Date.now();

    return {
      ok: true,
      message: "停止命令已发送",
      runtime: this.getRuntimeState(project.id)
    };
  }

  async restartProject(project) {
    const state = this.processes.get(project.id);
    if (state?.running) {
      await this.stopProject(project);
      await delay(800);
    }
    return this.startProject(project);
  }

  async openProject(project) {
    this.assertProjectShape(project);

    if (project.url) {
      assertValidUrl(project.url);
      openTarget(project.url, "url");
      await this.appendLog(project, `[${now()}] open url: ${project.url}\n`);
      return { ok: true, message: "已打开网址" };
    }

    const target = project.type === "folder" ? project.path : project.path || project.cwd;
    if (!target) {
      throw new Error("项目未配置可打开的 path、cwd 或 url");
    }

    assertPathExists(target);
    openTarget(target, project.type === "folder" ? "folder" : "file");
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
    openTarget(folder, "folder");
    await this.appendLog(project, `[${now()}] open folder: ${folder}\n`);
    return { ok: true, message: "已打开目录" };
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
      if (!project.path) throw new Error("bat 项目缺少 path");
      assertPathExists(project.path);
      const args = [`"${project.path}"`, ...normalizeArgs(project.args)];
      return {
        command: "cmd.exe",
        args: ["/d", "/c", args.join(" ")],
        cwd,
        shell: false,
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
    const script = kind === "url"
      ? `Start-Process -FilePath '${escapePowerShellString(target)}'`
      : `Start-Process -LiteralPath '${escapePowerShellString(target)}'`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return;
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
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
