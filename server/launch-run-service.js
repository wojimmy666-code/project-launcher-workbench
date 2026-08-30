const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const LOG_STREAMS = new Set(["combined", "stdout", "stderr"]);
const DEFAULT_MAX_RUNS_PER_PROJECT = 20;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 20 * 1024 * 1024;
const OUTPUT_SYNC_INTERVAL_MS = 300;

const PHASE_LABELS = {
  queued: "等待启动",
  validating: "校验配置",
  checking_ports: "检查端口",
  spawning: "创建进程",
  waiting_process: "等待进程",
  waiting_ports: "等待端口",
  verifying_ownership: "核验归属",
  ready: "启动完成",
  failed: "启动失败",
  cancelling: "正在取消",
  cancelled: "已取消",
  interrupted: "任务中断"
};

class LaunchRunService {
  constructor(options = {}) {
    this.runsRoot = options.runsRoot || defaultRunsRoot();
    this.maxRunsPerProject = Number(options.maxRunsPerProject || DEFAULT_MAX_RUNS_PER_PROJECT);
    this.maxAgeMs = Number(options.maxAgeMs || DEFAULT_MAX_AGE_MS);
    this.maxLogBytes = Number(options.maxLogBytes || DEFAULT_MAX_LOG_BYTES);
    this.getProcesses = options.getProcesses || (async () => []);
    this.getListeners = options.getListeners || (async () => []);
    this.spawnSync = options.spawnSync || spawnSync;
    this.runs = new Map();
    this.activeByProject = new Map();
    this.subscribers = new Map();
    this.monitors = new Map();
    fs.mkdirSync(this.runsRoot, { recursive: true });
    this.loadRuns();
  }

  startProject(project, executor, options = {}) {
    const activeId = this.activeByProject.get(project.id);
    if (activeId) {
      const error = new Error(`项目已有启动任务正在执行（${activeId}）`);
      error.statusCode = 409;
      error.details = { runId: activeId };
      throw error;
    }

    const run = this.createRun(project, options.action || "start");
    this.activeByProject.set(project.id, run.id);
    this.startMonitor(run);

    setImmediate(() => {
      this.executeRun(run, project, executor, options).catch((error) => {
        console.error(`[launch-run] ${run.id}: ${error.stack || error.message}`);
      });
    });

    return this.toPublicRun(run);
  }

  createRun(project, action) {
    const id = createRunId();
    const runDir = path.join(this.runsRoot, safeFilePart(project.id), id);
    fs.mkdirSync(runDir, { recursive: true });
    const paths = {
      runDir,
      summary: path.join(runDir, "summary.json"),
      events: path.join(runDir, "events.ndjson"),
      stdout: path.join(runDir, "stdout.log"),
      stderr: path.join(runDir, "stderr.log"),
      combined: path.join(runDir, "combined.log"),
      diagnostic: path.join(runDir, "diagnostic.md")
    };
    for (const file of [paths.events, paths.stdout, paths.stderr, paths.combined]) {
      fs.closeSync(fs.openSync(file, "a"));
    }

    const timestamp = new Date().toISOString();
    const run = {
      id,
      projectId: project.id,
      projectName: project.name || project.id,
      action,
      status: "queued",
      phase: "queued",
      phaseLabel: PHASE_LABELS.queued,
      message: "启动任务已创建",
      createdAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      completedAt: null,
      durationMs: null,
      exitCode: null,
      errorCode: null,
      errorMessage: null,
      result: null,
      cancelledAt: null,
      cancellationRequested: false,
      paths,
      project: sanitizeProject(project),
      sequence: 0,
      outputOffsets: { stdout: 0, stderr: 0 },
      lastEventSize: 0,
      abortController: new AbortController()
    };
    this.runs.set(id, run);
    this.appendEvent(run, {
      type: "stage",
      source: "workbench",
      stage: "queued",
      label: PHASE_LABELS.queued,
      message: run.message
    });
    this.persistRun(run);
    this.cleanupProjectRuns(project.id, id);
    return run;
  }

  async executeRun(run, project, executor, options) {
    const context = this.createContext(run);
    if (run.cancellationRequested) {
      try {
        await options.onCancel?.(context);
      } finally {
        this.finishCancelled(run);
        if (this.activeByProject.get(project.id) === run.id) this.activeByProject.delete(project.id);
        this.stopMonitor(run.id);
      }
      return;
    }
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.setStage(run, "validating", "正在校验项目配置");

    try {
      const result = await executor(context);
      if (run.cancellationRequested) {
        await options.onCancel?.(context);
        this.finishCancelled(run);
      } else {
        run.status = "succeeded";
        run.result = result || null;
        run.exitCode = extractExitCode(result);
        this.setStage(run, "ready", result?.message || "项目启动完成");
        this.finishRun(run);
      }
    } catch (error) {
      if (run.cancellationRequested || error?.name === "AbortError" || error?.code === "PROJECT_STARTUP_CANCELLED") {
        try {
          await options.onCancel?.(context);
        } catch (cleanupError) {
          await this.appendSystemLog(run, `取消后的进程清理失败：${cleanupError.message}\n`);
        }
        this.finishCancelled(run);
      } else {
        run.status = "failed";
        run.failedPhase = run.phase;
        run.failedPhaseLabel = run.phaseLabel;
        run.errorCode = error?.code || error?.details?.code || null;
        run.errorMessage = redact(error?.message || "启动失败");
        run.exitCode = extractExitCode(error);
        this.setStage(run, "failed", run.errorMessage, {
          errorCode: run.errorCode,
          exitCode: run.exitCode
        });
        this.finishRun(run);
        await this.generateDiagnostic(run, project, error);
      }
    } finally {
      if (this.activeByProject.get(project.id) === run.id) {
        this.activeByProject.delete(project.id);
      }
      this.stopMonitor(run.id);
      this.syncOutput(run);
      this.persistRun(run);
      this.emit(run);
    }
  }

  createContext(run) {
    const context = {
      runId: run.id,
      runDir: run.paths.runDir,
      logDir: run.paths.runDir,
      stdoutPath: run.paths.stdout,
      stderrPath: run.paths.stderr,
      combinedPath: run.paths.combined,
      eventFile: run.paths.events,
      diagnosticPath: run.paths.diagnostic,
      signal: run.abortController.signal,
      launched: false,
      launchPids: [],
      stage: (stage, message, details) => this.setStage(run, stage, message, details),
      log: (message) => this.appendSystemLog(run, message),
      markLaunched: (pid) => {
        context.launched = true;
        const normalizedPid = Number(pid);
        if (Number.isInteger(normalizedPid) && normalizedPid > 0 && !context.launchPids.includes(normalizedPid)) {
          context.launchPids.push(normalizedPid);
        }
      }
    };
    return context;
  }

  setStage(runOrId, phase, message, details = null) {
    const run = typeof runOrId === "string" ? this.runs.get(runOrId) : runOrId;
    if (!run || TERMINAL_STATUSES.has(run.status) && run.completedAt && phase !== run.phase) return null;
    run.phase = String(phase || "running");
    run.phaseLabel = PHASE_LABELS[run.phase] || String(details?.label || run.phase);
    run.message = redact(message || run.phaseLabel);
    run.updatedAt = new Date().toISOString();
    this.appendEvent(run, {
      type: "stage",
      source: "workbench",
      stage: run.phase,
      label: run.phaseLabel,
      message: run.message,
      details: details ? sanitizeDetails(details) : undefined
    });
    this.persistRun(run);
    this.emit(run);
    return this.toPublicRun(run);
  }

  cancelRun(runId) {
    const run = this.requireRun(runId);
    if (!ACTIVE_STATUSES.has(run.status)) {
      const error = new Error("该启动任务已经结束，无法取消");
      error.statusCode = 409;
      throw error;
    }
    if (!run.cancellationRequested) {
      run.cancellationRequested = true;
      run.cancelledAt = new Date().toISOString();
      run.status = "cancelling";
      this.setStage(run, "cancelling", "正在取消启动并清理已创建的进程");
      run.abortController.abort();
    }
    return this.toPublicRun(run);
  }

  dismissRun(runId) {
    const run = this.requireRun(runId);
    if (!TERMINAL_STATUSES.has(run.status)) {
      const error = new Error("启动任务仍在执行，无法关闭");
      error.statusCode = 409;
      throw error;
    }
    if (!run.dismissedAt) {
      run.dismissedAt = new Date().toISOString();
      this.persistRun(run);
    }
    return this.toPublicRun(run);
  }

  finishCancelled(run) {
    run.status = "cancelled";
    run.errorCode = "PROJECT_STARTUP_CANCELLED";
    run.errorMessage = "启动任务已取消";
    this.setStage(run, "cancelled", run.errorMessage);
    this.finishRun(run);
  }

  finishRun(run) {
    const completedAt = new Date();
    run.completedAt = completedAt.toISOString();
    run.updatedAt = run.completedAt;
    run.durationMs = Math.max(0, completedAt.getTime() - new Date(run.startedAt || run.createdAt).getTime());
    this.persistRun(run);
    this.emit(run);
  }

  getRun(runId) {
    const run = this.requireRun(runId);
    this.syncOutput(run);
    return this.toPublicRun(run);
  }

  getLatestRuns() {
    const latest = new Map();
    for (const run of this.runs.values()) {
      const current = latest.get(run.projectId);
      if (!current || Date.parse(run.createdAt) > Date.parse(current.createdAt)) {
        latest.set(run.projectId, run);
      }
    }
    return Object.fromEntries([...latest.entries()]
      .filter(([, run]) => !run.dismissedAt)
      .map(([projectId, run]) => [projectId, this.toPublicRun(run)]));
  }

  listProjectRuns(projectId, limit = 20) {
    const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, cappedLimit)
      .map((run) => this.toPublicRun(run));
  }

  readLogs(runId, options = {}) {
    const run = this.requireRun(runId);
    this.syncOutput(run);
    const stream = LOG_STREAMS.has(options.stream) ? options.stream : "combined";
    const file = run.paths[stream];
    const stat = fs.existsSync(file) ? fs.statSync(file) : { size: 0 };
    const requestedOffset = Math.max(0, Number(options.after || 0));
    const maxBytes = Math.max(1024, Math.min(1024 * 1024, Number(options.maxBytes || 256 * 1024)));
    const tail = Boolean(options.tail);
    const start = tail
      ? Math.max(0, stat.size - maxBytes)
      : (requestedOffset > stat.size ? 0 : requestedOffset);
    const end = Math.min(stat.size, start + maxBytes);
    const length = end - start;
    let content = "";
    if (length > 0) {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        content = redact(buffer.toString("utf8"));
      } finally {
        fs.closeSync(fd);
      }
    }
    return {
      runId: run.id,
      stream,
      content,
      offset: start,
      nextOffset: end,
      size: stat.size,
      hasMore: end < stat.size,
      path: file
    };
  }

  subscribe(runId, req, res) {
    const run = this.requireRun(runId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.toPublicRun(run))}\n\n`);
    const subscribers = this.subscribers.get(run.id) || new Set();
    subscribers.add(res);
    this.subscribers.set(run.id, subscribers);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keep-alive\n\n");
    }, 15000);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      subscribers.delete(res);
      if (!subscribers.size) this.subscribers.delete(run.id);
    };
    req.once("close", close);
    res.once("close", close);
  }

  async generateDiagnostic(run, project, error) {
    this.syncOutput(run);
    const [processes, listeners] = await Promise.all([
      this.getProcesses({ fresh: true }).catch(() => []),
      this.getListeners().catch(() => [])
    ]);
    const ports = projectPorts(project);
    const cwd = resolveProjectCwd(project);
    const git = cwd ? inspectGit(cwd, this.spawnSync) : {};
    const matchingProcesses = findRelatedProcesses(project, processes);
    const portChecks = ports.map((port) => ({
      port,
      pids: [...new Set((listeners || []).filter((item) => Number(item.port) === port).map((item) => Number(item.pid)))]
    }));
    const logTail = tailLines(readTail(run.paths.combined, 512 * 1024), 200);
    const stderrTail = tailLines(readTail(run.paths.stderr, 128 * 1024), 80);
    const auxiliaryLogs = readAuxiliaryLogs(run);
    const diagnostic = [
      `# 启动失败诊断：${run.projectName}`,
      "",
      `- Run ID: \`${run.id}\``,
      `- 项目 ID: \`${run.projectId}\``,
      `- 失败阶段: ${run.failedPhaseLabel || run.phaseLabel}（\`${run.failedPhase || run.phase}\`）`,
      `- 错误代码: \`${run.errorCode || "unknown"}\``,
      `- 退出码: \`${run.exitCode ?? "unknown"}\``,
      `- 错误信息: ${redact(run.errorMessage || error?.message || "启动失败")}`,
      `- 启动时间: ${run.startedAt || run.createdAt}`,
      `- 失败时间: ${run.completedAt || run.updatedAt}`,
      `- 工作目录: \`${redact(cwd || "unknown")}\``,
      `- Git 分支: \`${redact(git.branch || "unknown")}\``,
      `- Git 提交: \`${redact(git.commit || "unknown")}\``,
      "",
      "## 启动目标",
      "",
      "```text",
      redact(project.command || project.path || project.url || "unknown"),
      "```",
      "",
      "## 端口检查",
      "",
      ...(portChecks.length
        ? portChecks.map((item) => `- ${item.port}: ${item.pids.length ? `PID ${item.pids.join(", ")}` : "未监听"}`)
        : ["- 未配置端口"]),
      "",
      "## 相关进程",
      "",
      ...(matchingProcesses.length
        ? matchingProcesses.map((item) => `- PID ${item.ProcessId} ← ${item.ParentProcessId || "-"} · ${redact(item.Name || "unknown")} · ${redact(item.CommandLine || item.ExecutablePath || "")}`)
        : ["- 未发现匹配进程"]),
      "",
      "## stderr 尾部",
      "",
      "```text",
      redact(stderrTail || "(empty)"),
      "```",
      "",
      "## 合并日志尾部（最多 200 行）",
      "",
      "```text",
      redact(logTail || "(empty)"),
      "```",
      ...formatAuxiliaryLogDiagnostic(auxiliaryLogs),
      "",
      "## 完整日志",
      "",
      `- stdout: \`${run.paths.stdout}\``,
      `- stderr: \`${run.paths.stderr}\``,
      `- combined: \`${run.paths.combined}\``,
      `- events: \`${run.paths.events}\``,
      "",
      "> 诊断材料未包含完整环境变量；常见密码、Token、API Key 和 Secret 已脱敏。",
      ""
    ].join("\n");
    fs.writeFileSync(run.paths.diagnostic, diagnostic, "utf8");
    this.persistRun(run);
    this.emit(run);
    return run.paths.diagnostic;
  }

  getDiagnosticPath(runId) {
    const run = this.requireRun(runId);
    if (!fs.existsSync(run.paths.diagnostic)) {
      const error = new Error("该启动任务没有失败诊断文件");
      error.statusCode = 404;
      throw error;
    }
    return run.paths.diagnostic;
  }

  getRunDirectory(runId) {
    return this.requireRun(runId).paths.runDir;
  }

  appendEvent(run, event) {
    const payload = {
      sequence: ++run.sequence,
      at: new Date().toISOString(),
      ...event
    };
    fs.appendFileSync(run.paths.events, `${JSON.stringify(payload)}\n`, "utf8");
    run.lastEventSize = fs.statSync(run.paths.events).size;
    return payload;
  }

  async appendSystemLog(run, message) {
    const content = redact(String(message || ""));
    if (!content) return;
    fs.appendFileSync(run.paths.combined, `[${new Date().toISOString()}] [workbench] ${content}`, "utf8");
  }

  syncOutput(run) {
    const chunks = [];
    for (const stream of ["stdout", "stderr"]) {
      const file = run.paths[stream];
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      let offset = Math.min(Number(run.outputOffsets[stream] || 0), stat.size);
      if (stat.size <= offset) continue;
      const remaining = stat.size - offset;
      const start = remaining > this.maxLogBytes ? stat.size - this.maxLogBytes : offset;
      const length = stat.size - start;
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        chunks.push({ stream, content: redact(buffer.toString("utf8")), mtimeMs: stat.mtimeMs });
      } finally {
        fs.closeSync(fd);
      }
      run.outputOffsets[stream] = stat.size;
      this.cropLogFile(file, Math.floor(this.maxLogBytes / 3));
    }
    chunks.sort((left, right) => left.mtimeMs - right.mtimeMs || left.stream.localeCompare(right.stream));
    for (const chunk of chunks) {
      fs.appendFileSync(run.paths.combined, chunk.content, "utf8");
    }
    this.cropLogFile(run.paths.combined, Math.floor(this.maxLogBytes / 3));
    this.detectExternalEvents(run);
  }

  detectExternalEvents(run) {
    if (!fs.existsSync(run.paths.events)) return;
    const stat = fs.statSync(run.paths.events);
    if (stat.size <= Number(run.lastEventSize || 0)) return;
    const previousSize = Number(run.lastEventSize || 0);
    const length = stat.size - previousSize;
    const fd = fs.openSync(run.paths.events, "r");
    let text = "";
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, previousSize);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    run.lastEventSize = stat.size;
    let changed = false;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (event.source === "workbench" || event.type !== "stage") continue;
        const stage = String(event.stage || event.id || "custom").trim();
        const label = String(event.label || event.name || stage).trim();
        if (!stage || !label) continue;
        run.phase = `custom:${stage}`;
        run.phaseLabel = label;
        run.message = String(event.message || label);
        run.updatedAt = new Date().toISOString();
        changed = true;
      } catch {
        // An incomplete writer line will be picked up by the next valid event.
      }
    }
    if (changed) {
      this.persistRun(run);
      this.emit(run);
    }
  }

  cropLogFile(file, maxBytes = this.maxLogBytes) {
    try {
      if (!fs.existsSync(file)) return;
      const stat = fs.statSync(file);
      if (stat.size <= maxBytes) return;
      const content = readTail(file, maxBytes);
      fs.writeFileSync(file, `[日志已按 ${maxBytes} 字节上限截取尾部]\n${content}`, "utf8");
    } catch {
      // An active child can briefly hold the file against truncation on Windows.
    }
  }

  startMonitor(run) {
    const timer = setInterval(() => {
      try {
        const before = `${run.outputOffsets.stdout}:${run.outputOffsets.stderr}:${run.lastEventSize}`;
        this.syncOutput(run);
        const after = `${run.outputOffsets.stdout}:${run.outputOffsets.stderr}:${run.lastEventSize}`;
        if (before !== after) this.emit(run);
      } catch {
        // A transient read race must not fail the launch itself.
      }
    }, OUTPUT_SYNC_INTERVAL_MS);
    timer.unref?.();
    this.monitors.set(run.id, timer);
  }

  stopMonitor(runId) {
    const timer = this.monitors.get(runId);
    if (timer) clearInterval(timer);
    this.monitors.delete(runId);
  }

  emit(run) {
    const subscribers = this.subscribers.get(run.id);
    if (!subscribers?.size) return;
    const payload = `event: update\ndata: ${JSON.stringify(this.toPublicRun(run))}\n\n`;
    for (const response of subscribers) {
      if (!response.destroyed) response.write(payload);
    }
  }

  toPublicRun(run) {
    this.detectExternalEvents(run);
    return {
      id: run.id,
      projectId: run.projectId,
      projectName: run.projectName,
      action: run.action,
      status: run.status,
      phase: run.phase,
      phaseLabel: run.phaseLabel,
      message: run.message,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      failedPhase: run.failedPhase || null,
      failedPhaseLabel: run.failedPhaseLabel || null,
      dismissedAt: run.dismissedAt || null,
      cancellationRequested: run.cancellationRequested,
      active: ACTIVE_STATUSES.has(run.status),
      failed: ["failed", "interrupted"].includes(run.status),
      canCancel: ["queued", "running"].includes(run.status),
      hasDiagnostic: fs.existsSync(run.paths.diagnostic),
      logDirectory: run.paths.runDir,
      diagnosticPath: fs.existsSync(run.paths.diagnostic) ? run.paths.diagnostic : null,
      result: run.result
    };
  }

  persistRun(run) {
    const data = {
      version: 1,
      ...this.toPublicRunWithoutDetection(run),
      project: run.project,
      paths: run.paths,
      sequence: run.sequence,
      outputOffsets: run.outputOffsets
    };
    writeJsonAtomic(run.paths.summary, data);
  }

  toPublicRunWithoutDetection(run) {
    return {
      id: run.id,
      projectId: run.projectId,
      projectName: run.projectName,
      action: run.action,
      status: run.status,
      phase: run.phase,
      phaseLabel: run.phaseLabel,
      message: run.message,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      failedPhase: run.failedPhase || null,
      failedPhaseLabel: run.failedPhaseLabel || null,
      dismissedAt: run.dismissedAt || null,
      cancellationRequested: run.cancellationRequested,
      cancelledAt: run.cancelledAt,
      result: run.result
    };
  }

  loadRuns() {
    const summaries = findFiles(this.runsRoot, "summary.json", 3);
    for (const summaryPath of summaries) {
      try {
        const data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        if (!data.id || !data.projectId) continue;
        const runDir = path.dirname(summaryPath);
        const paths = {
          runDir,
          summary: summaryPath,
          events: data.paths?.events || path.join(runDir, "events.ndjson"),
          stdout: data.paths?.stdout || path.join(runDir, "stdout.log"),
          stderr: data.paths?.stderr || path.join(runDir, "stderr.log"),
          combined: data.paths?.combined || path.join(runDir, "combined.log"),
          diagnostic: data.paths?.diagnostic || path.join(runDir, "diagnostic.md")
        };
        const run = {
          ...data,
          paths,
          sequence: Number(data.sequence || 0),
          outputOffsets: data.outputOffsets || { stdout: 0, stderr: 0 },
          lastEventSize: fs.existsSync(paths.events) ? fs.statSync(paths.events).size : 0,
          abortController: new AbortController()
        };
        if (ACTIVE_STATUSES.has(run.status)) {
          run.failedPhase = run.phase;
          run.failedPhaseLabel = run.phaseLabel;
          run.status = "interrupted";
          run.phase = "interrupted";
          run.phaseLabel = PHASE_LABELS.interrupted;
          run.message = "管理台在启动任务完成前重新启动；请核对项目状态和日志";
          run.errorCode = "WORKBENCH_RESTARTED_DURING_LAUNCH";
          run.errorMessage = run.message;
          run.completedAt = new Date().toISOString();
          run.updatedAt = run.completedAt;
          run.durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt || run.createdAt));
          this.appendEvent(run, {
            type: "stage",
            source: "workbench",
            stage: "interrupted",
            label: PHASE_LABELS.interrupted,
            message: run.message
          });
          writeInterruptedDiagnostic(run);
          this.persistRun(run);
        }
        this.runs.set(run.id, run);
      } catch {
        // Ignore corrupt historical entries; their raw files remain available.
      }
    }
  }

  cleanupProjectRuns(projectId, keepRunId) {
    const nowMs = Date.now();
    const runs = [...this.runs.values()]
      .filter((run) => run.projectId === projectId && run.id !== keepRunId && !ACTIVE_STATUSES.has(run.status))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    for (const [index, run] of runs.entries()) {
      const expired = nowMs - Date.parse(run.createdAt) > this.maxAgeMs;
      const overLimit = index >= Math.max(0, this.maxRunsPerProject - 1);
      if (!expired && !overLimit) continue;
      try {
        fs.rmSync(run.paths.runDir, { recursive: true, force: true });
        this.runs.delete(run.id);
      } catch {
        // Retention cleanup retries on a later launch.
      }
    }
  }

  requireRun(runId) {
    const run = this.runs.get(String(runId || ""));
    if (!run) {
      const error = new Error("启动任务不存在");
      error.statusCode = 404;
      throw error;
    }
    return run;
  }
}

function defaultRunsRoot() {
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), ".project-launcher-workbench");
  return path.join(appData, "ProjectLauncherWorkbench", "runs");
}

function createRunId() {
  return `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function sanitizeProject(project) {
  return {
    id: String(project.id || ""),
    name: String(project.name || project.id || ""),
    type: String(project.type || ""),
    cwd: redact(project.cwd || ""),
    codexCwd: redact(project.codexCwd || ""),
    path: redact(project.path || ""),
    command: redact(project.command || ""),
    url: redact(project.url || ""),
    port: Number(project.port) || null,
    auxiliaryPorts: projectPorts(project).filter((port) => port !== Number(project.port)),
    processMatch: (project.processMatch || []).map(redact)
  };
}

function projectPorts(project) {
  return [...new Set([project.port, ...(project.auxiliaryPorts || [])]
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

function resolveProjectCwd(project) {
  const candidate = project.codexCwd || project.cwd || (project.path ? path.dirname(project.path) : "");
  return candidate ? path.resolve(candidate) : "";
}

function inspectGit(cwd, runSpawnSync) {
  const exec = (args) => {
    const result = runSpawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  };
  try {
    return {
      branch: exec(["branch", "--show-current"]),
      commit: exec(["rev-parse", "HEAD"])
    };
  } catch {
    return {};
  }
}

function findRelatedProcesses(project, processes) {
  const needles = [
    project.cwd,
    project.codexCwd,
    project.path,
    ...(project.processMatch || [])
  ].map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  if (!needles.length) return [];
  return (processes || []).filter((item) => {
    const haystack = `${item.ExecutablePath || ""}\n${item.CommandLine || ""}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  }).slice(0, 80);
}

function extractExitCode(value) {
  const candidates = [value?.exitCode, value?.details?.exitCode, value?.runtime?.exitCode];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const number = Number(candidate);
    if (Number.isInteger(number)) return number;
  }
  return null;
}

function readTail(file, maxBytes) {
  if (!fs.existsSync(file)) return "";
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

function tailLines(value, count) {
  return String(value || "").split(/\r?\n/).slice(-count).join("\n");
}

function readAuxiliaryLogs(run) {
  const runDir = run?.paths?.runDir;
  if (!runDir || !fs.existsSync(runDir)) return [];
  const excluded = new Set([
    run.paths.stdout,
    run.paths.stderr,
    run.paths.combined
  ].map((file) => path.resolve(file).toLowerCase()));

  try {
    return fs.readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.log$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, file: path.join(runDir, entry.name) }))
      .filter((entry) => !excluded.has(path.resolve(entry.file).toLowerCase()))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 10)
      .map((entry) => ({
        ...entry,
        tail: tailLines(readTail(entry.file, 128 * 1024), 80)
      }));
  } catch {
    return [];
  }
}

function formatAuxiliaryLogDiagnostic(logs) {
  if (!logs.length) return [];
  return [
    "",
    "## 子进程独立日志",
    "",
    ...logs.flatMap((entry) => [
      `### ${redact(entry.name.replace(/`/g, "'"))}`,
      "",
      `- 路径: \`${redact(entry.file)}\``,
      "",
      "```text",
      redact(entry.tail || "(empty)"),
      "```",
      ""
    ])
  ];
}

function writeInterruptedDiagnostic(run) {
  const logTail = tailLines(redact(readTail(run.paths.combined, 512 * 1024)), 200);
  const auxiliaryLogs = readAuxiliaryLogs(run);
  const diagnostic = [
    `# 启动任务中断诊断：${run.projectName}`,
    "",
    `- Run ID: \`${run.id}\``,
    `- 项目 ID: \`${run.projectId}\``,
    `- 中断阶段: ${run.failedPhaseLabel || run.phaseLabel}（\`${run.failedPhase || run.phase}\`）`,
    `- 错误代码: \`${run.errorCode}\``,
    `- 工作目录: \`${redact(run.project?.codexCwd || run.project?.cwd || "unknown")}\``,
    "",
    "管理台在本次启动确认完成前重新启动。请先核对项目当前运行状态，再结合日志判断启动是否实际成功。",
    "",
    "## 合并日志尾部（最多 200 行）",
    "",
    "```text",
    logTail || "(empty)",
    "```",
    ...formatAuxiliaryLogDiagnostic(auxiliaryLogs),
    "",
    "## 完整日志",
    "",
    `- stdout: \`${run.paths.stdout}\``,
    `- stderr: \`${run.paths.stderr}\``,
    `- combined: \`${run.paths.combined}\``,
    `- events: \`${run.paths.events}\``,
    ""
  ].join("\n");
  fs.writeFileSync(run.paths.diagnostic, diagnostic, "utf8");
}

function safeFilePart(value) {
  return String(value || "project").replace(/[^a-z0-9._-]/gi, "_");
}

function redact(input) {
  return String(input || "")
    .replace(/(password|passwd|pwd)\s*[:=]\s*([^\s]+)/gi, "$1=<redacted>")
    .replace(/(token|api[_-]?key|secret)\s*[:=]\s*([^\s]+)/gi, "$1=<redacted>")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1<redacted>");
}

function sanitizeDetails(value, depth = 0) {
  if (depth > 5) return "<omitted>";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDetails(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      /(password|passwd|pwd|token|api[_-]?key|secret)/i.test(key)
        ? "<redacted>"
        : sanitizeDetails(item, depth + 1)
    ]));
  }
  return value;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function findFiles(root, fileName, depth) {
  if (depth < 0 || !fs.existsSync(root)) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) results.push(target);
    if (entry.isDirectory()) results.push(...findFiles(target, fileName, depth - 1));
  }
  return results;
}

module.exports = {
  ACTIVE_STATUSES,
  LaunchRunService,
  PHASE_LABELS,
  defaultRunsRoot,
  redact
};
