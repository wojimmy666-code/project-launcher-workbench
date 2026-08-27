const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LaunchRunService } = require("../server/launch-run-service");

function createService(t, options = {}) {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launch-runs-"));
  t.after(() => fs.rmSync(runsRoot, { recursive: true, force: true }));
  return new LaunchRunService({
    runsRoot,
    getProcesses: async () => [],
    getListeners: async () => [],
    ...options
  });
}

async function waitForRun(service, runId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (!run.active) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for launch run");
}

test("launch run returns immediately and persists isolated stage and output files", async (t) => {
  const service = createService(t);
  const project = { id: "demo", name: "Demo", type: "cmd", cwd: process.cwd(), command: "node demo.js" };
  const created = service.startProject(project, async (context) => {
    context.stage("spawning", "正在创建测试进程");
    fs.appendFileSync(context.stdoutPath, "server ready\n", "utf8");
    fs.appendFileSync(context.stderrPath, "warning only\n", "utf8");
    return { ok: true, message: "项目已启动" };
  });

  assert.equal(created.status, "queued");
  assert.equal(created.active, true);

  const completed = await waitForRun(service, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.phase, "ready");
  assert.equal(completed.message, "项目已启动");

  const stdout = service.readLogs(created.id, { stream: "stdout" });
  const stderr = service.readLogs(created.id, { stream: "stderr" });
  const combined = service.readLogs(created.id, { stream: "combined" });
  assert.match(stdout.content, /server ready/);
  assert.match(stderr.content, /warning only/);
  assert.match(combined.content, /server ready/);
  assert.match(combined.content, /warning only/);
  assert.equal(fs.existsSync(path.join(completed.logDirectory, "summary.json")), true);
  assert.equal(fs.existsSync(path.join(completed.logDirectory, "events.ndjson")), true);
});

test("failed launch keeps its real failure phase and creates a redacted Codex diagnostic", async (t) => {
  const service = createService(t, {
    getProcesses: async () => [{
      ProcessId: 42,
      ParentProcessId: 7,
      Name: "node.exe",
      CommandLine: `${process.cwd()} token=process-secret`
    }],
    getListeners: async () => [{ port: 4174, pid: 42 }],
    spawnSync: () => ({ status: 0, stdout: "main\n" })
  });
  const project = {
    id: "failed-demo",
    name: "Failed Demo",
    type: "cmd",
    cwd: process.cwd(),
    command: "node demo.js api_key=command-secret",
    port: 4174,
    processMatch: [process.cwd()]
  };
  const created = service.startProject(project, async (context) => {
    context.stage("waiting_ports", "等待 4174 端口");
    fs.appendFileSync(context.stderrPath, "password=stderr-secret\n", "utf8");
    fs.appendFileSync(path.join(context.logDir, "mode1-risk-instance.log"), "risk child failed token=child-secret\n", "utf8");
    const error = new Error("token=error-secret connection refused");
    error.code = "TEST_START_FAILURE";
    error.exitCode = 9;
    throw error;
  });

  const completed = await waitForRun(service, created.id);
  assert.equal(completed.status, "failed");
  assert.equal(completed.failedPhase, "waiting_ports");
  assert.equal(completed.exitCode, 9);
  assert.equal(completed.hasDiagnostic, true);
  assert.doesNotMatch(completed.errorMessage, /error-secret/);

  const diagnostic = fs.readFileSync(completed.diagnosticPath, "utf8");
  assert.match(diagnostic, /等待端口/);
  assert.match(diagnostic, /TEST_START_FAILURE/);
  assert.match(diagnostic, /mode1-risk-instance\.log/);
  assert.match(diagnostic, /risk child failed/);
  assert.match(diagnostic, /<redacted>/);
  assert.doesNotMatch(diagnostic, /stderr-secret|command-secret|process-secret|error-secret|child-secret/);
});

test("project supplied NDJSON stages can refine the generic launch progress", async (t) => {
  const service = createService(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const created = service.startProject({ id: "custom-stage", name: "Custom stage" }, async (context) => {
    fs.appendFileSync(context.eventFile, `${JSON.stringify({
      type: "stage",
      stage: "database_migration",
      label: "迁移数据库",
      message: "正在应用 3 个迁移"
    })}\n`, "utf8");
    await gate;
    return { ok: true, message: "完成" };
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  const active = service.getRun(created.id);
  assert.equal(active.phase, "custom:database_migration");
  assert.equal(active.phaseLabel, "迁移数据库");
  release();
  await waitForRun(service, created.id);
});

test("cancelling a launch aborts the executor and invokes process cleanup", async (t) => {
  const service = createService(t);
  let cleaned = false;
  const created = service.startProject({ id: "cancel-demo", name: "Cancel demo" }, async (context) => {
    await new Promise((resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }, {
    onCancel: async () => { cleaned = true; }
  });

  service.cancelRun(created.id);
  const completed = await waitForRun(service, created.id);
  assert.equal(completed.status, "cancelled");
  assert.equal(cleaned, true);
});

test("an active run is restored as interrupted with a durable diagnostic", async (t) => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launch-runs-restart-"));
  t.after(() => fs.rmSync(runsRoot, { recursive: true, force: true }));
  const first = new LaunchRunService({ runsRoot });
  const created = first.startProject({
    id: "restart-demo",
    name: "Restart demo",
    cwd: process.cwd()
  }, async (context) => {
    context.stage("waiting_ports", "等待服务端口");
    await new Promise(() => {});
  });

  const deadline = Date.now() + 1000;
  while (first.getRun(created.id).phase !== "waiting_ports" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  first.stopMonitor(created.id);

  const restored = new LaunchRunService({ runsRoot });
  const run = restored.getRun(created.id);
  assert.equal(run.status, "interrupted");
  assert.equal(run.failedPhase, "waiting_ports");
  assert.equal(run.hasDiagnostic, true);
  assert.match(fs.readFileSync(run.diagnosticPath, "utf8"), /管理台在本次启动确认完成前重新启动/);
});
