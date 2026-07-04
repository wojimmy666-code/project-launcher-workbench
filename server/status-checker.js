const net = require("node:net");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");

const STARTING_WINDOW_MS = 30000;
const PROCESS_SNAPSHOT_TTL_MS = 60000;
const MEMORY_HISTORY_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MEMORY_HISTORY_MAX_SAMPLES = 240;
const MEMORY_SAMPLE_MIN_INTERVAL_MS = 30000;
const MEMORY_ALERT_WINDOW_MS = 10 * 60 * 1000;
const MEMORY_ALERT_WARMUP_MS = 2 * 60 * 1000;
const MEMORY_LEAK_MIN_DELTA_BYTES = 128 * 1024 * 1024;
const MEMORY_LEAK_MIN_DELTA_RATIO = 0.25;
const MEMORY_LEAK_MIN_INCREASE_RATIO = 0.7;
const MEMORY_LEAK_MIN_SLOPE_BYTES_PER_MINUTE = 1 * 1024 * 1024;
const MEMORY_WATCH_MIN_DELTA_BYTES = 64 * 1024 * 1024;
const MEMORY_WATCH_MIN_SLOPE_BYTES_PER_MINUTE = 512 * 1024;
const MEMORY_WARNING_PRIVATE_BYTES = 1024 * 1024 * 1024;
const MEMORY_CRITICAL_PRIVATE_BYTES = 2 * 1024 * 1024 * 1024;
let processSnapshot = null;
const memoryHistory = new Map();

async function checkProjectStatus(project, runtimeState) {
  const runtimePids = new Set(Array.isArray(runtimeState?.pids) ? runtimeState.pids.map(Number) : []);

  if (Number.isInteger(project.port)) {
    const open = await isPortOpen(project.host || "127.0.0.1", project.port);
    const portPids = open && project.detectExternal !== false ? await findPortPids(project.port) : [];
    const externalPids = portPids.filter((pid) => !runtimePids.has(pid));
    const processInfo = withMemoryInfo({ portPids, externalPids }, runtimePids);

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
  const processInfo = withMemoryInfo({ processPids, externalPids }, runtimePids);

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

  const processes = getWindowsProcessesByWmic() || getWindowsProcessesByPowerShell();
  processSnapshot = { expiresAt: now + PROCESS_SNAPSHOT_TTL_MS, processes };
  return processes;
}

function getWindowsProcessesByWmic() {
  const result = spawnSync("wmic", [
    "process",
    "get",
    "ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CreationDate,ExecutablePath,CommandLine",
    "/format:csv"
  ], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 30 * 1024 * 1024
  });

  if (result.error || result.status !== 0) return null;

  const decoded = new TextDecoder("gb18030").decode(result.stdout || Buffer.alloc(0));
  const processes = parseWmicCsv(String(decoded));
  return processes.length ? processes : null;
}

function getWindowsProcessesByPowerShell() {
  const script = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize,PrivatePageCount,CreationDate | ConvertTo-Json -Compress"
  ].join("; ");

  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });

  return result.error || result.status !== 0 ? [] : parseJsonList(result.stdout);
}

function withMemoryInfo(processInfo, runtimePids = new Set()) {
  return {
    ...processInfo,
    memory: getProcessMemoryInfo([
      ...runtimePids,
      ...(processInfo.portPids || []),
      ...(processInfo.processPids || [])
    ])
  };
}

function getProcessMemoryInfo(rootPids) {
  const roots = [...new Set((rootPids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!roots.length || process.platform !== "win32") {
    return emptyMemoryInfo(roots);
  }

  const processes = getWindowsProcesses();
  const byPid = new Map();
  const childrenByParent = new Map();

  for (const item of processes) {
    const pid = Number(item.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(pid, item);

    const parentPid = Number(item.ParentProcessId);
    if (Number.isInteger(parentPid) && parentPid > 0) {
      if (!childrenByParent.has(parentPid)) childrenByParent.set(parentPid, []);
      childrenByParent.get(parentPid).push(pid);
    }
  }

  const queue = [...roots];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const childPid of childrenByParent.get(pid) || []) {
      if (!seen.has(childPid)) queue.push(childPid);
    }
  }

  const details = [...seen]
    .filter((pid) => pid !== process.pid && byPid.has(pid))
    .map((pid) => {
      const item = byPid.get(pid);
      return {
        pid,
        parentPid: Number(item.ParentProcessId) || null,
        name: String(item.Name || ""),
        createdAt: normalizeProcessCreationDate(item.CreationDate),
        workingSetBytes: normalizeByteCount(item.WorkingSetSize),
        privateBytes: normalizeByteCount(item.PrivatePageCount)
      };
    })
    .sort((a, b) => a.pid - b.pid);

  const alerts = updateMemoryHistoryAndDetectAlerts(details);

  return {
    rootPids: roots,
    pids: details.map((item) => item.pid),
    processCount: details.length,
    workingSetBytes: details.reduce((sum, item) => sum + item.workingSetBytes, 0),
    privateBytes: details.reduce((sum, item) => sum + item.privateBytes, 0),
    alertLevel: summarizeAlertLevel(alerts),
    alerts,
    processes: details
  };
}

function emptyMemoryInfo(rootPids = []) {
  return {
    rootPids,
    pids: [],
    processCount: 0,
    workingSetBytes: 0,
    privateBytes: 0,
    alertLevel: "normal",
    alerts: [],
    processes: []
  };
}

function normalizeByteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function updateMemoryHistoryAndDetectAlerts(details, now = Date.now()) {
  const liveKeys = new Set();
  const alerts = [];

  for (const detail of details) {
    const key = getProcessMemoryKey(detail, now);
    liveKeys.add(key);

    const createdAt = detail.createdAt || now;
    let entry = memoryHistory.get(key);
    if (!entry) {
      entry = {
        key,
        pid: detail.pid,
        name: detail.name,
        createdAt,
        lastSeenAt: now,
        samples: []
      };
      memoryHistory.set(key, entry);
    }

    entry.pid = detail.pid;
    entry.name = detail.name;
    entry.createdAt = entry.createdAt || createdAt;
    entry.lastSeenAt = now;

    addMemorySample(entry, {
      at: now,
      privateBytes: detail.privateBytes,
      workingSetBytes: detail.workingSetBytes
    });

    const alert = analyzeMemoryTrend(entry, detail, now);
    if (alert) alerts.push(alert);
  }

  cleanupMemoryHistory(now, liveKeys);
  return alerts.sort(compareAlerts);
}

function addMemorySample(entry, sample) {
  const samples = entry.samples;
  const last = samples[samples.length - 1];
  if (last && sample.at - last.at < MEMORY_SAMPLE_MIN_INTERVAL_MS) {
    samples[samples.length - 1] = sample;
  } else {
    samples.push(sample);
  }

  const oldestAllowed = sample.at - MEMORY_HISTORY_MAX_AGE_MS;
  while (samples.length > MEMORY_HISTORY_MAX_SAMPLES || (samples.length && samples[0].at < oldestAllowed)) {
    samples.shift();
  }
}

function analyzeMemoryTrend(entry, detail, now) {
  const currentPrivateBytes = detail.privateBytes;
  const ageMs = now - (entry.createdAt || now);

  if (ageMs >= MEMORY_ALERT_WARMUP_MS) {
    if (currentPrivateBytes >= MEMORY_CRITICAL_PRIVATE_BYTES) {
      return createMemoryAlert("critical", "high_private_memory", entry, detail, now, {
        windowSamples: entry.samples,
        deltaBytes: 0,
        deltaRatio: 0,
        increaseRatio: 0,
        slopeBytesPerMinute: 0
      });
    }

    if (currentPrivateBytes >= MEMORY_WARNING_PRIVATE_BYTES) {
      return createMemoryAlert("warning", "high_private_memory", entry, detail, now, {
        windowSamples: entry.samples,
        deltaBytes: 0,
        deltaRatio: 0,
        increaseRatio: 0,
        slopeBytesPerMinute: 0
      });
    }
  }

  const windowSamples = entry.samples.filter((sample) => sample.at >= now - MEMORY_ALERT_WINDOW_MS);
  if (ageMs < MEMORY_ALERT_WARMUP_MS || windowSamples.length < 6) {
    return null;
  }

  const first = windowSamples[0];
  const last = windowSamples[windowSamples.length - 1];
  const elapsedMinutes = Math.max((last.at - first.at) / 60000, 0.001);
  const deltaBytes = last.privateBytes - first.privateBytes;
  const deltaRatio = first.privateBytes > 0 ? deltaBytes / first.privateBytes : 0;
  const increaseRatio = calculateIncreaseRatio(windowSamples);
  const slopeBytesPerMinute = deltaBytes / elapsedMinutes;

  const trend = { windowSamples, deltaBytes, deltaRatio, increaseRatio, slopeBytesPerMinute };
  const leakLike = deltaBytes >= MEMORY_LEAK_MIN_DELTA_BYTES
    && deltaRatio >= MEMORY_LEAK_MIN_DELTA_RATIO
    && increaseRatio >= MEMORY_LEAK_MIN_INCREASE_RATIO
    && slopeBytesPerMinute >= MEMORY_LEAK_MIN_SLOPE_BYTES_PER_MINUTE;

  if (leakLike) {
    const level = currentPrivateBytes >= MEMORY_CRITICAL_PRIVATE_BYTES ? "critical" : "warning";
    return createMemoryAlert(level, "private_memory_growth", entry, detail, now, trend);
  }

  const watchLike = deltaBytes >= MEMORY_WATCH_MIN_DELTA_BYTES
    && increaseRatio >= 0.6
    && slopeBytesPerMinute >= MEMORY_WATCH_MIN_SLOPE_BYTES_PER_MINUTE;

  if (watchLike) {
    return createMemoryAlert("watch", "private_memory_growth", entry, detail, now, trend);
  }

  return null;
}

function calculateIncreaseRatio(samples) {
  if (samples.length < 2) return 0;

  let increases = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].privateBytes > samples[index - 1].privateBytes) {
      increases += 1;
    }
  }

  return increases / (samples.length - 1);
}

function createMemoryAlert(level, reason, entry, detail, now, trend) {
  const windowSamples = trend.windowSamples || [];
  const first = windowSamples[0] || null;
  const last = windowSamples[windowSamples.length - 1] || null;
  const windowMinutes = first && last ? Math.max((last.at - first.at) / 60000, 0) : 0;

  return {
    level,
    pid: detail.pid,
    name: detail.name,
    reason,
    currentPrivateBytes: detail.privateBytes,
    currentWorkingSetBytes: detail.workingSetBytes,
    windowMinutes,
    sampleCount: windowSamples.length,
    deltaBytes: Math.max(0, Math.round(trend.deltaBytes || 0)),
    deltaRatio: Number((trend.deltaRatio || 0).toFixed(4)),
    increaseRatio: Number((trend.increaseRatio || 0).toFixed(4)),
    slopeBytesPerMinute: Math.max(0, Math.round(trend.slopeBytesPerMinute || 0)),
    firstSampleAt: first ? new Date(first.at).toISOString() : null,
    lastSampleAt: last ? new Date(last.at).toISOString() : null,
    checkedAt: new Date(now).toISOString()
  };
}

function summarizeAlertLevel(alerts) {
  if (!alerts.length) return "normal";
  if (alerts.some((alert) => alert.level === "critical")) return "critical";
  if (alerts.some((alert) => alert.level === "warning")) return "warning";
  return "watch";
}

function compareAlerts(a, b) {
  const weight = { critical: 3, warning: 2, watch: 1, normal: 0 };
  return (weight[b.level] || 0) - (weight[a.level] || 0)
    || (b.currentPrivateBytes || 0) - (a.currentPrivateBytes || 0);
}

function cleanupMemoryHistory(now, liveKeys) {
  for (const [key, entry] of memoryHistory) {
    if (liveKeys.has(key)) continue;
    if (now - entry.lastSeenAt > MEMORY_HISTORY_MAX_AGE_MS) {
      memoryHistory.delete(key);
    }
  }
}

function getProcessMemoryKey(detail, now = Date.now()) {
  const createdAt = detail.createdAt || now;
  return `${detail.pid}:${createdAt}`;
}

function normalizeProcessCreationDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();

  const text = String(value).trim();
  if (!text) return null;

  const wmiMatch = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (wmiMatch) {
    const [, year, month, day, hour, minute, second] = wmiMatch;
    const timestamp = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const dotNetMatch = text.match(/Date\((\d+)\)/);
  if (dotNetMatch) {
    const timestamp = Number(dotNetMatch[1]);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
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
  getProcessMemoryInfo,
  isPortOpen,
  parseNetstatPids
};
