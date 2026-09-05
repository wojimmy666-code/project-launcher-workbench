const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createCommandLine,
  createPlan,
  parseArguments,
  resolveEffectiveRole
} = require("../scripts/run-process-role");

test("role runner parses a command without shell interpolation", () => {
  const parsed = parseArguments([
    "service",
    "--cwd",
    "D:\\Projects\\Example App",
    "--",
    "D:\\Program Files\\nodejs\\node.exe",
    "server.js",
    "--port",
    "3000"
  ]);

  assert.equal(parsed.role, "service");
  assert.equal(parsed.cwd, path.resolve("D:\\Projects\\Example App"));
  assert.equal(parsed.executable, "D:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(parsed.args, ["server.js", "--port", "3000"]);
  assert.equal(createCommandLine(parsed.executable, parsed.args),
    '"D:\\Program Files\\nodejs\\node.exe" server.js --port 3000');
});

test("service visibility follows its own permission and never grants interaction", () => {
  assert.equal(resolveEffectiveRole("service", {
    PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES: "1",
    PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE: "0"
  }), "service");
  assert.equal(resolveEffectiveRole("service", {
    PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES: "0",
    PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE: "1"
  }), "intermediate");
  assert.throws(() => resolveEffectiveRole("interactive", {
    PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE: "0"
  }), /permission was not granted/);
});

test("role plan is versioned and writes only to the launch log directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-role-plan-"));
  try {
    const plan = createPlan({
      role: "service",
      cwd: tempDir,
      executable: process.execPath,
      args: ["server.js"]
    }, {
      PROJECT_LAUNCHER_LOG_DIR: tempDir,
      PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES: "1"
    });

    assert.equal(plan.version, 1);
    assert.equal(plan.windowRole, "service");
    assert.equal(plan.cwd, tempDir);
    assert.equal(path.dirname(plan.stdoutPath), tempDir);
    assert.equal(path.dirname(plan.stderrPath), tempDir);
    assert.doesNotMatch(JSON.stringify(plan), /PROJECT_LAUNCHER_/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
