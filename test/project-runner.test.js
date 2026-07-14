const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ProjectRunner,
  collapseProcessTreePids,
  killProcessTree
} = require("../server/project-runner");

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

test("nested process IDs collapse to independent roots", () => {
  const roots = collapseProcessTreePids([100, 101, 102, 200], [
    { pid: 100, parentPid: 1 },
    { pid: 101, parentPid: 100 },
    { pid: 102, parentPid: 101 },
    { pid: 200, parentPid: 1 }
  ]);

  assert.deepEqual(roots, [100, 200]);
});

test("stop excludes tracked descendants from external processes", async () => {
  const projectId = "tracked-tree-stop-test";
  const state = {
    pid: 910001,
    running: true,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null
  };

  class StopRunner extends ProjectRunner {
    constructor() {
      super();
      this.processes.set(projectId, [state]);
      this.killedPids = [];
      this.trackedPids = [];
    }

    getRunningStates() {
      return [state];
    }

    getTrackedProcessTreePids() {
      return [910001, 910002];
    }

    async findExternalPids(_project, trackedPids) {
      this.trackedPids = [...trackedPids];
      return [910002, 910003].filter((pid) => !trackedPids.has(pid));
    }

    getIndependentProcessRoots(pids) {
      return pids;
    }

    async killProcessTree(pid) {
      this.killedPids.push(pid);
    }

    async appendLog() {}
    saveRuntimeState() {}
  }

  const runner = new StopRunner();
  await runner.stopProject({ id: projectId, allowStopExternal: true });

  assert.deepEqual(runner.trackedPids, [910001, 910002]);
  assert.deepEqual(runner.killedPids, [910001, 910003]);
  assert.equal(state.running, false);
});

test("stopping an already exited PID succeeds", async () => {
  await assert.doesNotReject(() => killProcessTree(99999999));
});

test("external process control checks always request a fresh process list", async () => {
  class FreshLookupRunner extends ProjectRunner {
    async findProjectPids(_project, options) {
      this.lookupOptions = options;
      return [];
    }
  }

  const runner = new FreshLookupRunner();
  await runner.findExternalPids({ detectExternal: true }, new Set());
  assert.deepEqual(runner.lookupOptions, { fresh: true });
});
