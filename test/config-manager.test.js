const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { normalizeProjectForSave, validateProject } = require("../server/config-manager");

function project(overrides = {}) {
  return {
    id: "candidate",
    name: "Candidate",
    type: "cmd",
    category: "uncategorized",
    command: "node",
    cwd: process.cwd(),
    port: 3000,
    ...overrides
  };
}

test("temperature sweep strategy stays multi-instance while its console is hidden", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "projects.json"), "utf8"));
  const temperatureSweep = config.projects.find((item) => item.id === "Polymarket-Temp");

  assert.ok(temperatureSweep);
  assert.equal(temperatureSweep.allowMultiple, true);
  assert.equal(temperatureSweep.hideConsole, true);
  assert.equal(temperatureSweep.hideLauncherConsole, true);
  assert.equal(temperatureSweep.showServiceConsoles, true);
  assert.equal(temperatureSweep.allowInteractiveConsole, true);
  assert.equal(temperatureSweep.allowChildConsole, true);
});

test("GoldAlpha health checks use the API port started by its launcher", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "projects.json"), "utf8"));
  const goldAlpha = config.projects.find((item) => item.id === "gold-alpha");

  assert.ok(goldAlpha);
  assert.deepEqual(goldAlpha.auxiliaryPorts, [8110]);
});

test("two runnable projects cannot be configured with the same port", () => {
  const existing = project({ id: "existing", name: "Existing project" });

  assert.throws(
    () => validateProject(project(), [existing], null, []),
    /\u7aef\u53e3 3000 \u5df2\u7531\u9879\u76ee\u300cExisting project\u300d\u4f7f\u7528/
  );
});

test("updating a project may keep its own port", () => {
  const existing = project({ id: "existing", name: "Existing project" });

  assert.doesNotThrow(() => validateProject(
    project({ id: "existing", name: "Existing project" }),
    [existing],
    "existing",
    []
  ));
});

test("process matchers are normalized from newline input", () => {
  const normalized = normalizeProjectForSave(project({
    processMatch: "analysis_lab.cli\n--port 8023\nanalysis_lab.cli"
  }), []);

  assert.deepEqual(normalized.processMatch, ["analysis_lab.cli", "--port 8023"]);
});

test("console roles are normalized and keep legacy aliases synchronized", () => {
  const normalized = normalizeProjectForSave(project({
    hideLauncherConsole: true,
    showServiceConsoles: false,
    allowInteractiveConsole: true
  }), []);

  assert.equal(normalized.hideLauncherConsole, true);
  assert.equal(normalized.showServiceConsoles, false);
  assert.equal(normalized.allowInteractiveConsole, true);
  assert.equal(normalized.hideConsole, true);
  assert.equal(normalized.allowChildConsole, true);
});

test("legacy console settings migrate to role-based settings", () => {
  const normalized = normalizeProjectForSave(project({
    hideConsole: true,
    allowChildConsole: true
  }), []);

  assert.equal(normalized.hideLauncherConsole, true);
  assert.equal(normalized.showServiceConsoles, true);
  assert.equal(normalized.allowInteractiveConsole, true);
});

test("startup lifecycle and confirmation timeout are normalized", () => {
  const normalized = normalizeProjectForSave(project({
    launchMode: "DETACHED",
    startupTimeoutMs: "60000"
  }), []);

  assert.equal(normalized.launchMode, "detached");
  assert.equal(normalized.startupTimeoutMs, 60000);
});

test("startup confirmation timeout rejects values outside the safe range", () => {
  assert.throws(
    () => validateProject(project({ startupTimeoutMs: 999 }), [], null, []),
    /1000-600000/
  );
});

test("process matchers reject unsafe short values", () => {
  assert.throws(
    () => validateProject(project({ processMatch: ["x"] }), [], null, []),
    /3-200/
  );
});

test("auxiliary ports are normalized from multiline input", () => {
  const normalized = normalizeProjectForSave(project({
    auxiliaryPorts: "8000\n8001\n8000"
  }), []);

  assert.deepEqual(normalized.auxiliaryPorts, [8000, 8001]);
});

test("an auxiliary port cannot duplicate the primary port", () => {
  assert.throws(
    () => validateProject(project({ auxiliaryPorts: [3000] }), [], null, []),
    /\u8f85\u52a9\u7aef\u53e3\u4e0d\u80fd\u4e0e\u4e3b\u7aef\u53e3\u76f8\u540c/
  );
});

test("primary and auxiliary ports are unique across projects", () => {
  const existing = project({
    id: "existing",
    name: "Existing project",
    port: 4174,
    auxiliaryPorts: [8000]
  });

  assert.throws(
    () => validateProject(project({ port: 8000 }), [existing], null, []),
    /\u7aef\u53e3 8000 \u5df2\u7531\u9879\u76ee\u300cExisting project\u300d\u4f7f\u7528/
  );
});
