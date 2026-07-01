const net = require("node:net");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");

const STARTING_WINDOW_MS = 30000;
const PROCESS_SNAPSHOT_TTL_MS = 2000;
let processSnapshot = null;

async function checkProjectStatus(project, runtimeState) {
  const runtimePids = new Set(Array.isArray(runtimeState?.pids) ? runtimeState.pids.map(Number) : []);

  if (Number.isInteger(project.port)) {
    const open = await isPortOpen(project.host || "127.0.0.1", project.port);
    const portPids = open && project.detectExternal !== false ? await findPortPids(project.port) : [];
    const externalPids = portPids.filter((pid) => !runtimePids.has(pid));
    const processInfo = { portPids, externalPids };

    if (open) {
      const message = externalPids.length && !runtimeState?.running
        ? "\u7aef\u53e3\u53ef\u8bbf\u95ee\uff0c\u68c0\u6d4b\u5230\u5916\u90e8\u8fdb\u7a0b"
        : "\u7aef\u53e3\u53ef\u8bbf\u95ee";
      return status("running", message, processInfo);
    }

    if (runtimeState?.running) {
      const age = Date.now() - runtimeState.startedAt;
      if (age < STARTING_WINDOW_MS) {
        return status("starting", "\u8fdb\u7a0b\u5df2\u542f\u52a8\uff0c\u7b49\u5f85\u7aef\u53e3\u54cd\u5e94", processInfo);
      }
      return status("error", "\u8fdb\u7a0b\u5b58\u5728\uff0c\u4f46\u7aef\u53e3\u672a\u54cd\u5e94", processInfo);
    }

    if (runtimeState?.exitCode && runtimeState.exitCode !== 0) {
      return status("error", `\u8fdb\u7a0b\u5f02\u5e38\u9000\u51fa\uff0c\u9000\u51fa\u7801 ${runtimeState.exitCode}`, processInfo);
    }

    return status("stopped", "\u7aef\u53e3\u672a\u54cd\u5e94", processInfo);
  }

  const processPids = project.detectExternal !== false ? await findProjectPids(project) : [];
  const externalPids = processPids.filter((pid) => !runtimePids.has(pid));
  const processInfo = { processPids, externalPids };

  if (runtimeState?.running) {
    return status("running", "\u7531\u5de5\u4f5c\u53f0\u542f\u52a8\u7684\u8fdb\u7a0b\u4ecd\u5728\u8fd0\u884c", processInfo);
  }

  if (externalPids.length) {
    return status("running", "\u68c0\u6d4b\u5230\u5916\u90e8\u8fdb\u7a0b", processInfo);
  }

  if (runtimeState?.exitCode && runtimeState.exitCode !== 0) {
    return status("error", `\u8fdb\u7a0b\u5f02\u5e38\u9000\u51fa\uff0c\u9000\u51fa\u7801 ${runtimeState.exitCode}`, processInfo);
  }

  if (runtimeState?.exitedAt) {
    return status("stopped", "\u8fdb\u7a0b\u5df2\u9000\u51fa", processInfo);
  }

  if (project.path || project.command) {
    return status("stopped", "\u672a\u68c0\u6d4b\u5230\u5339\u914d\u8fdb\u7a0b", processInfo);
  }

  return status("unknown", "\u672a\u914d\u7f6e\u7aef\u53e3\u6216\u8fdb\u7a0b\u68c0\u6d4b\u65b9\u5f0f", processInfo);
}

function isPortOpen(host, port, timeout = 750) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function findPortPids(port) {
  if (!Number.isInteger(port)) return Promise.resolve([]);
  if (process.platform !== "win32") return Promise.resolve([]);

  return new Promise((resolve) => {
    execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(parseNetstatPids(stdout, port));
    });
  });
}

function parseNetstatPids(output, port) {
  const pids = new Set();
  const targetSuffix = `:${port}`;

  for (const line of String(output).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;

    const stateIndex = parts.findIndex((part) => part.toUpperCase() === "LISTENING");
    if (stateIndex === -1) continue;

    const localAddress = parts[1] || "";
    const pid = Number(parts[stateIndex + 1]);
    if (localAddress.endsWith(targetSuffix) && Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return [...pids];
}

async function findProjectPids(project) {
  if (process.platform !== "win32") return [];

  const resolvedPath = project.path ? path.resolve(project.path) : "";
  const targetPath = resolvedPath ? normalizeComparablePath(resolvedPath) : "";
  const commandNeedle = normalizeCommandNeedle(project.command || project.path || "");
  if (!targetPath && !commandNeedle) return [];

  const pids = new Set();

  if (resolvedPath) {
    for (const pid of await findWindowsPidsByPath(resolvedPath)) {
      pids.add(pid);
    }
    if (pids.size) return [...pids];
  }

  const processes = await getWindowsProcesses();

  for (const item of processes) {
    const pid = Number(item.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;

    const executablePath = normalizeComparablePath(item.ExecutablePath || "");
    const commandLine = normalizeComparableText(item.CommandLine || "");

    if (targetPath && executablePath === targetPath) {
      pids.add(pid);
      continue;
    }

    if (commandNeedle && commandLine.includes(commandNeedle)) {
      pids.add(pid);
    }
  }

  return [...pids];
}

async function findWindowsPidsByPath(targetPath) {
  if (!targetPath || process.platform !== "win32") return Promise.resolve([]);

  if (path.extname(targetPath).toLowerCase() === ".exe") {
    const pids = findWindowsExePidsByWmic(targetPath);
    if (pids.length) return pids;
  }

  const script = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "$target = $env:PROJECT_LAUNCHER_TARGET_PATH",
    "$projectLauncherMatches = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.ExecutablePath -ieq $target -or ($_.CommandLine -and $_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0)) } | Select-Object -ExpandProperty ProcessId",
    "$projectLauncherMatches | ConvertTo-Json -Compress"
  ].join("; ");

  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "buffer",
    windowsHide: true,
    env: {
      ...process.env,
      PROJECT_LAUNCHER_TARGET_PATH: targetPath
    }
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return parsePidList(result.stdout);
}

function findWindowsExePidsByWmic(targetPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pids = findWindowsExePidsByWmicOnce(targetPath);
    if (pids.length || attempt === 2) return pids;
    sleepSync(120);
  }

  return [];
}

function findWindowsExePidsByWmicOnce(targetPath) {
  const imageName = path.basename(targetPath || "");
  if (!imageName) return [];

  const query = `name='${imageName.replace(/'/g, "''")}'`;
  const result = spawnSync("wmic", ["process", "where", query, "get", "ProcessId,Name,ExecutablePath", "/format:csv"], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024
  });

  if (result.error || result.status !== 0) return [];

  const decoded = new TextDecoder("gb18030").decode(result.stdout || Buffer.alloc(0));
  const rows = parseWmicCsv(String(decoded));
  const target = normalizeComparablePath(targetPath);
  const pids = [];

  for (const row of rows) {
    if (normalizeComparablePath(row.ExecutablePath) !== target) continue;
    const pid = Number(row.ProcessId);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      pids.push(pid);
    }
  }

  return pids;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseWmicCsv(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, values[index] || ""]));
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function getWindowsProcesses() {
  const now = Date.now();
  if (processSnapshot && processSnapshot.expiresAt > now) {
    return processSnapshot.processes;
  }

  const script = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
  ].join("; ");

  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });

  const processes = result.error || result.status !== 0 ? [] : parseJsonList(result.stdout);
  processSnapshot = { expiresAt: now + PROCESS_SNAPSHOT_TTL_MS, processes };
  return processes;
}

function normalizeCommandNeedle(value) {
  return normalizeComparableText(value).replace(/^"|"$/g, "");
}

function normalizeComparablePath(value) {
  return normalizeComparableText(value).replace(/\//g, "\\");
}

function normalizeComparableText(value) {
  return String(value || "").trim().toLowerCase();
}

function parseJsonList(stdout) {
  const text = Buffer.from(stdout || "").toString("utf8").trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function parsePidList(stdout) {
  return parsePidText(Buffer.from(stdout || "").toString("utf8"));
}

function parsePidText(value) {
  const text = String(value || "").trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}


function status(state, message, extra = {}) {
  return {
    state,
    message,
    checkedAt: new Date().toISOString(),
    ...extra
  };
}

module.exports = {
  checkProjectStatus,
  findPortPids,
  findProjectPids,
  findWindowsPidsByPath,
  findWindowsExePidsByWmic,
  isPortOpen,
  parseNetstatPids
};
