const assert = require("node:assert/strict");
const test = require("node:test");
const { ProjectRunner } = require("../server/project-runner");

class ExternalProcessRunner extends ProjectRunner {
  async findExternalPids() {
    return [4321];
  }

  async appendLog() {}
}

test("single-instance project does not start when an external process is detected", async () => {
  const runner = new ExternalProcessRunner();
  const result = await runner.startProject({
    id: "external-process-test",
    name: "External process test",
    type: "cmd",
    command: "this-command-must-not-run",
    allowMultiple: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.external, true);
  assert.deepEqual(result.externalPids, [4321]);
});
