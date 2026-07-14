const assert = require("node:assert/strict");
const test = require("node:test");
const { checkProjectStatus } = require("../server/status-checker");

const project = {
  path: __filename,
  detectExternal: false
};

test("a nonzero exit caused by a user stop is reported as stopped", async () => {
  const result = await checkProjectStatus(project, {
    running: false,
    pids: [],
    exitedAt: Date.now(),
    exitCode: 1,
    stoppedByUser: true
  });

  assert.equal(result.state, "stopped");
  assert.equal(result.message, "\u5df2\u624b\u52a8\u505c\u6b62");
});

test("an unexpected nonzero exit is still reported as an error", async () => {
  const result = await checkProjectStatus(project, {
    running: false,
    pids: [],
    exitedAt: Date.now(),
    exitCode: 1,
    stoppedByUser: false
  });

  assert.equal(result.state, "error");
  assert.match(result.message, /1$/);
});
