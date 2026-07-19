const assert = require("node:assert/strict");
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

test("process matchers reject unsafe short values", () => {
  assert.throws(
    () => validateProject(project({ processMatch: ["x"] }), [], null, []),
    /3-200/
  );
});
