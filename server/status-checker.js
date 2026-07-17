const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const { resolveProjectPort } = require("./project-port");
const { ProcessSnapshotCache } = require("./process-snapshot-cache");

const STARTING_WINDOW_MS = 30000;
const PROCESS_SNAPSHOT_TTL_MS = 15000;
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
const processSnapshotCache = new ProcessSnapshotCache(PROCESS_SNAPSHOT_TTL_MS);
const memoryHistory = new Map();

async function checkProjectStatus(project, runtimeState, options = {}) {
  const runtimePids = new Set(Array.isArray(runtimeState?.pids) ? runtimeState.pids.map(Number) : []);
  const projectPort = resolveProjectPort(project);

  if (Number.isInteger(projectPort)) {
    const open = await isPortOpen(project.host || "127.0.0.1", projectPort);
    // Port ownership is a safety check, so it must not be disabled with
    // detectExternal. Otherwise any unrelated listener is reported as running.
    const portPids = open ? await findPortPids(projectPort) : [];
    const ownership = classifyProjectPids(project, portPids, {
      runtimePids,
      knownProjects: options.projects
    });
    const selfManaged = ownership.ownedPids.includes(process.pid);
    const externalPids = ownership.ownedPids.filter((pid) => pid !== process.pid && !runtimePids.has(pid));
    const management = selfManaged ? "self" : getManagementState(runtimeState, externalPids);
    const processInfo = withMemoryInfo({
      port: projectPort,
      portPids,
      ownedPortPids: ownership.ownedPids,
      externalPids,
      conflictPids: ownership.foreignPids,
      conflicts: ownership.conflicts,
      management,
      selfManaged,
      canAdopt: !selfManaged
        && management === "external"
        && externalPids.length === 1
        && ownership.foreignPids.length === 0
    }, runtimePids);

    if (runtimeState?.stopping) {
      return status("stopping", "\u6b63\u5728\u505c\u6b62\u9879\u76ee", processInfo);
    }

    if (open && ownership.foreignPids.length) {
      return status("conflict", formatPortConflictMessage(projectPort, ownership.conflicts), processInfo);
    }

    if (open && !portPids.length && !runtimeState?.running) {
      return status("conflict", "端口 " + projectPort + " 可访问，但无法确认占用进程", processInfo);
    }

    if (open) {
      const message = management === "self"
        ? "当前项目管理台后台正在运行"
        : management === "external"
        ? "\u7aef\u53e3\u53ef\u8bbf\u95ee\uff0c\u9879\u76ee\u7531\u5916\u90e8\u542f\u52a8"
        : management === "mixed"
          ? "\u7aef\u53e3\u53ef\u8bbf\u95ee\uff0c\u7ba1\u7406\u53f0\u4e0e\u5916\u90e8\u5b9e\u4f8b\u540c\u65f6\u8fd0\u884c"
        : management === "adopted"
          ? "\u7aef\u53e3\u53ef\u8bbf\u95ee\uff0c\u5916\u90e8\u8fdb\u7a0b\u5df2\u63a5\u7ba1"
          : "\u7aef\u53e3\u53ef\u8bbf\u95ee\uff0c\u9879\u76ee\u7531\u7ba1\u7406\u53f0\u542f\u52a8";
      return status("running", message, processInfo);
    }

    if (runtimeState?.running) {
      const age = Date.now() - runtimeState.startedAt;
      if (age < STARTING_WINDOW_MS) {
        return status("starting", "\u8fdb\u7a0b\u5df2\u542f\u52a8\uff0c\u7b49\u5f85\u7aef\u53e3\u54cd\u5e94", processInfo);
      }
      return status("error", "\u8fdb\u7a0b\u5b58\u5728\uff0c\u4f46\u7aef\u53e3\u672a\u54cd\u5e94", processInfo);
    }

    if (runtimeState?.stoppedByUser) {
      return status("stopped", "\u5df2\u624b\u52a8\u505c\u6b62", processInfo);
    }

    if (runtimeState?.exitCode && runtimeState.exitCode !== 0) {
      return status("error", "\u8fdb\u7a0b\u5f02\u5e38\u9000\u51fa\uff0c\u9000\u51fa\u7801 " + runtimeState.exitCode, processInfo);
    }

    return status("stopped", "\u7aef\u53e3\u672a\u54cd\u5e94", processInfo);
  }

  const processPids = project.detectExternal !== false ? await findProjectPids(project) : [];
  const externalPids = processPids.filter((pid) => !runtimePids.has(pid));
  const management = getManagementState(runtimeState, externalPids);
  const processInfo = withMemoryInfo({
    processPids,
    externalPids,
    management,
    canAdopt: management === "external" && externalPids.length === 1
  }, runtimePids);

  if (runtimeState?.stopping) {
    return status("stopping", "\u6b63\u5728\u505c\u6b62\u9879\u76ee", processInfo);
  }

  if (runtimeState?.running) {
    const message = management === "mixed"
      ? "\u7ba1\u7406\u53f0\u4e0e\u5916\u90e8\u5b9e\u4f8b\u540c\u65f6\u8fd0\u884c"
      : management === "adopted"
      ? "\u5916\u90e8\u8fdb\u7a0b\u5df2\u63a5\u7ba1"
      : "\u7531\u5de5\u4f5c\u53f0\u542f\u52a8\u7684\u8fdb\u7a0b\u4ecd\u5728\u8fd0\u884c";
    return status("running", message, processInfo);
  }

  if (externalPids.length) {
    return status("running", "\u9879\u76ee\u7531\u5916\u90e8\u542f\u52a8", processInfo);
  }

  if (runtimeState?.stoppedByUser) {
    return status("stopped", "\u5df2\u624b\u52a8\u505c\u6b62", processInfo);
  }

  if (runtimeState?.exitCode && runtimeState.exitCode !== 0) {
    return status("error", "\u8fdb\u7a0b\u5f02\u5e38\u9000\u51fa\uff0c\u9000\u51fa\u7801 " + runtimeState.exitCode, processInfo);
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

async function findProjectPids(project, options = {}) {
  if (process.platform !== "win32") return [];

  const processes = await getWindowsProcesses(options);
  const byPid = createProcessMap(processes);
  const pids = [];

  for (const item of processes) {
    const pid = Number(item.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (processLineageMatchesProject(project, pid, byPid)) {
      pids.push(pid);
    }
  }

  return [...new Set(pids)];
}

function classifyProjectPids(project, candidatePids, options = {}) {
  const pids = [...new Set((candidatePids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!pids.length) {
    return { ownedPids: [], foreignPids: [], conflicts: [] };
  }

  const runtimePids = options.runtimePids instanceof Set
    ? options.runtimePids
    : new Set((options.runtimePids || []).map(Number));
  const processes = Array.isArray(options.processes) ? options.processes : getWindowsProcesses(options);
  const byPid = createProcessMap(processes);
  const knownProjects = Array.isArray(options.knownProjects) ? options.knownProjects : [];
  const currentPid = Number.isInteger(Number(options.currentPid))
    ? Number(options.currentPid)
    : process.pid;
  const ownedPids = [];
  const foreignPids = [];
  const conflicts = [];

  for (const pid of pids) {
    // If the listener is this backend process itself, it is necessarily owned
    // by the row whose configured port produced this candidate. This remains
    // safe for child projects because only the actual listening PID is checked;
    // descendants merely sharing this process as an ancestor are not claimed.
    if (pid === currentPid || runtimePids.has(pid) || processLineageMatchesProject(project, pid, byPid)) {
      ownedPids.push(pid);
      continue;
    }

    const ownerProject = knownProjects.find((candidate) => (
      candidate?.id !== project?.id && processLineageMatchesProject(candidate, pid, byPid)
    )) || null;
    const item = byPid.get(pid);
    foreignPids.push(pid);
    conflicts.push({
      pid,
      name: String(item?.Name || ""),
      executablePath: String(item?.ExecutablePath || ""),
      commandLine: String(item?.CommandLine || ""),
      ownerProjectId: ownerProject?.id || null,
      ownerProjectName: ownerProject?.name || null
    });
  }

  return { ownedPids, foreignPids, conflicts };
}

function processLineageMatchesProject(project, pid, byPid) {
  if (!project || !Number.isInteger(Number(pid)) || !byPid?.size) return false;

  const originPid = Number(pid);
  let currentPid = Number(pid);
  const seen = new Set();
  for (let depth = 0; depth < 16 && currentPid > 0 && !seen.has(currentPid); depth += 1) {
    seen.add(currentPid);
    const item = byPid.get(currentPid);
    if (!item) break;
    // Child projects launched by this workbench share the workbench process as
    // an ancestor. Do not let that ancestor claim every child process.
    if (currentPid === process.pid && originPid !== process.pid) break;
    // Codex and its helper shells commonly include the repository working
    // directory in their command lines. That describes the editing session,
    // not a running project service, so do not inherit ownership through that
    // part of the process tree. A real service still matches above this
    // boundary when its own command line contains the project launch path.
    if (isCodexToolProcess(item)) break;
    if (processMatchesProject(project, item)) return true;
    currentPid = Number(item.ParentProcessId) || 0;
  }

  return false;
}

function isCodexToolProcess(item) {
  const name = path.basename(normalizeComparablePath(item?.Name || item?.ExecutablePath || ""));
  const commandLine = normalizeComparableText(item?.CommandLine || "").replace(/\//g, "\\");
  if ([
    "codex",
    "codex.exe",
    "codex-code-mode-host",
    "codex-code-mode-host.exe",
    "node_repl",
    "node_repl.exe"
  ].includes(name)) {
    return true;
  }

  return /(?:^|[\\\s'"=;,&|])@openai\\codex(?:[\\\s'"=;,&|]|$)/.test(commandLine)
    || /(?:^|[\\\s'"=;,&|])codex-code-mode-host(?:\.exe)?(?:[\\\s'"=;,&|]|$)/.test(commandLine)
    || /(?:^|[\\\s'"=;,&|])node_repl(?:\.exe|\.js)?(?:[\\\s'"=;,&|]|$)/.test(commandLine)
    || /(?:^|[\\\s'"=;,&|])codex(?:\.exe|\.cmd)?(?:[\\\s'"=;,&|]|$)/.test(commandLine);
}

function processMatchesProject(project, item) {
  const executablePath = normalizeComparablePath(item?.ExecutablePath || "");
  const commandLine = normalizeComparablePath(item?.CommandLine || "");
  const identity = getProjectProcessIdentity(project);

  if (identity.executablePaths.some((candidate) => executablePath === candidate)) {
    return true;
  }

  return identity.commandNeedles.some((needle) => commandLineContainsPath(commandLine, needle));
}

function commandLineContainsPath(commandLine, needle) {
  let index = commandLine.indexOf(needle);
  while (index !== -1) {
    const end = index + needle.length;
    const next = commandLine[end] || "";
    if (!next || next === "\\" || /[\s"',;)]/.test(next)) {
      return true;
    }
    index = commandLine.indexOf(needle, index + 1);
  }
  return false;
}

function getProjectProcessIdentity(project = {}) {
  const executablePaths = [];
  const commandNeedles = [];
  const addNeedle = (value) => {
    const normalized = normalizeComparablePath(value);
    if (!normalized || normalized.length < 4 || isFilesystemRoot(normalized)) return;
    commandNeedles.push(normalized);
  };

  const projectPath = project.path ? path.resolve(project.path) : "";
  const commandPath = getAbsoluteCommandPath(project.command);
  if (projectPath && path.extname(projectPath).toLowerCase() === ".exe") {
    executablePaths.push(normalizeComparablePath(projectPath));
  }

  addNeedle(projectPath);
  addNeedle(commandPath);

  for (const candidate of [projectPath, commandPath]) {
    if (!candidate) continue;
    const directory = path.dirname(candidate);
    addNeedle(directory);
    if (path.basename(directory).toLowerCase() === "scripts") {
      addNeedle(path.dirname(directory));
    }
  }

  // cwd/codexCwd are fallback identities for relative commands. When a launch
  // path exists, a shared repository root is too broad and can make sibling
  // projects claim each other's processes.
  if (!commandNeedles.length && !executablePaths.length) {
    addNeedle(project.cwd);
    addNeedle(project.codexCwd);
  }

  return {
    executablePaths: [...new Set(executablePaths)],
    commandNeedles: [...new Set(commandNeedles)].sort((left, right) => right.length - left.length)
  };
}

function getAbsoluteCommandPath(command) {
  const text = String(command || "").trim().replace(/^"|"$/g, "");
  return path.isAbsolute(text) ? path.resolve(text) : "";
}

function isFilesystemRoot(value) {
  const parsed = path.parse(value);
  return normalizeComparablePath(parsed.root) === value;
}

function createProcessMap(processes) {
  const byPid = new Map();
  for (const item of processes || []) {
    const pid = Number(item?.ProcessId);
    if (Number.isInteger(pid) && pid > 0) byPid.set(pid, item);
  }
  return byPid;
}

function getManagementState(runtimeState, externalPids = []) {
  if (runtimeState?.running) {
    if (externalPids.length) return "mixed";
    return runtimeState.source === "adopted" ? "adopted" : "managed";
  }
  return externalPids.length ? "external" : null;
}

function getProcessIdentity(pid, options = {}) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return null;

  const processes = getWindowsProcesses(options);
  const item = processes.find((candidate) => Number(candidate?.ProcessId) === targetPid);
  if (!item) return processes.length ? null : getProcessIdentityFallback(targetPid);

  return createProcessIdentity(targetPid, item);
}

function createProcessIdentity(targetPid, item) {
  const commandLine = normalizeComparableText(item.CommandLine || "");
  return {
    pid: targetPid,
    name: normalizeComparableText(item.Name || ""),
    createdAt: normalizeProcessCreationDate(item.CreationDate),
    executablePath: normalizeComparablePath(item.ExecutablePath || ""),
    commandFingerprint: commandLine ? hashProcessValue(commandLine) : null
  };
}

function getProcessIdentityFallback(targetPid) {
  if (process.platform !== "win32") return null;

  const script = [
    "$ErrorActionPreference='Stop'",
    `[int]$targetPid=${targetPid}`,
    "$process=Get-Process -Id $targetPid -ErrorAction Stop",
    "$processPath=$null",
    "try { $processPath=$process.Path } catch {}",
    "$processName=if ($processPath) { [System.IO.Path]::GetFileName($processPath) } else { $process.ProcessName + '.exe' }",
    "[PSCustomObject]@{ ProcessId=$process.Id; Name=$processName; ExecutablePath=$processPath; CommandLine=$null; CreationDate=$process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) return null;

  const item = parseJsonList(result.stdout)[0];
  return item ? createProcessIdentity(targetPid, item) : null;
}

function processIdentityMatches(expected, current) {
  if (!expected || !current || Number(expected.pid) !== Number(current.pid)) return false;

  let compared = false;
  const expectedCreatedAt = Number(expected.createdAt || 0);
  const currentCreatedAt = Number(current.createdAt || 0);
  if (expectedCreatedAt && currentCreatedAt) {
    compared = true;
    if (Math.abs(expectedCreatedAt - currentCreatedAt) > 2000) return false;
  }

  if (expected.executablePath && current.executablePath) {
    compared = true;
    if (normalizeComparablePath(expected.executablePath) !== normalizeComparablePath(current.executablePath)) {
      return false;
    }
  }

  if (expected.commandFingerprint && current.commandFingerprint) {
    compared = true;
    if (expected.commandFingerprint !== current.commandFingerprint) return false;
  }

  return compared;
}

function hashProcessValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function formatPortConflictMessage(port, conflicts) {
  const conflict = conflicts?.[0] || null;
  const owner = conflict?.ownerProjectName || conflict?.name || "\u5176\u4ed6\u8fdb\u7a0b";
  const pidText = conflict?.pid ? "\uff08PID " + conflict.pid + "\uff09" : "";
  return "\u7aef\u53e3 " + port + " \u5df2\u88ab " + owner + pidText + "\u5360\u7528";
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

function getWindowsProcesses(options = {}) {
  return processSnapshotCache.get(
    () => getWindowsProcessesByWmic() || getWindowsProcessesByPowerShell(),
    options
  );
}

function invalidateProcessSnapshot() {
  processSnapshotCache.invalidate();
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
      ...(processInfo.ownedPortPids || []),
      ...(processInfo.processPids || [])
    ])
  };
}

function getProcessMemoryInfo(rootPids, options = {}) {
  const roots = [...new Set((rootPids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const platform = options.platform || process.platform;
  if (!roots.length || platform !== "win32") {
    return emptyMemoryInfo(roots);
  }

  const currentPid = Number.isInteger(options.currentPid) ? options.currentPid : process.pid;
  const processes = Array.isArray(options.processes) ? options.processes : getWindowsProcesses(options);
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

    // The workbench launches other configured projects. When its own PID is
    // the root, those projects belong to their own dashboard rows rather than
    // to the workbench's memory total.
    if (pid === currentPid) continue;

    for (const childPid of childrenByParent.get(pid) || []) {
      if (!seen.has(childPid)) queue.push(childPid);
    }
  }

  const details = [...seen]
    .filter((pid) => byPid.has(pid))
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

  const alerts = options.trackHistory === false ? [] : updateMemoryHistoryAndDetectAlerts(details);

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
    // Refresh the values inside the current sampling bucket without moving
    // its start time. Moving the timestamp on every 5-second dashboard poll
    // prevents the 30-second interval from ever elapsing.
    samples[samples.length - 1] = {
      ...sample,
      at: last.at
    };
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
  addMemorySample,
  checkProjectStatus,
  classifyProjectPids,
  findPortPids,
  findProjectPids,
  findWindowsPidsByPath,
  findWindowsExePidsByWmic,
  getProcessIdentity,
  getProcessMemoryInfo,
  getManagementState,
  invalidateProcessSnapshot,
  isPortOpen,
  parseNetstatPids,
  processIdentityMatches,
  processLineageMatchesProject,
  processMatchesProject
};
