const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const test = require("node:test");
const {
  ProjectRunner,
  collapseProcessTreePids,
  compactProcessStates,
  createProjectEnvironment,
  getTrackedAncestorPids,
  killProcessTree,
  spawnIndependentProcess,
  waitForProjectStop
} = require("../server/project-runner");

class TestProjectRunner extends ProjectRunner {
  constructor(options = {}) {
    super({ loadRuntimeState: false, ...options });
  }
}

class ExternalProcessRunner extends TestProjectRunner {
  async findExternalPids() {
    return [4321];
  }

  async appendLog() {}
}

function waitFor(condition, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (condition()) {
          resolve();
          return;
        }
      } catch {}

      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
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

test("a non-listening related process does not block a single-instance port project", async () => {
  class ClosedPortExternalProcessRunner extends ExternalProcessRunner {
    async isPortOpen() {
      return false;
    }

    async findProjectListeningInstances() {
      return [];
    }

    createLaunchSpec() {
      throw new Error("LAUNCH_REACHED");
    }
  }

  const runner = new ClosedPortExternalProcessRunner();
  await assert.rejects(
    () => runner.startProject({
      id: "external-process-port-test",
      name: "External process port test",
      type: "cmd",
      command: "this-command-must-not-run",
      allowMultiple: false,
      port: 3010
    }),
    (error) => {
      assert.equal(error.message, "LAUNCH_REACHED");
      return true;
    }
  );
});

test("a listener on another project port blocks a strict single-instance start", async () => {
  class AlternateListenerRunner extends TestProjectRunner {
    async isPortOpen() {
      return false;
    }

    async findProjectListeningInstances() {
      return [{
        ports: [3000],
        pids: [208],
        rootPids: [24008],
        processes: []
      }];
    }

    async appendLog() {}
  }

  const runner = new AlternateListenerRunner();
  await assert.rejects(
    () => runner.startProject({
      id: "beauty-training",
      name: "Beauty training",
      type: "cmd",
      command: "this-command-must-not-run",
      allowMultiple: false,
      port: 3010
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "PROJECT_ALTERNATE_INSTANCE_RUNNING");
      assert.match(error.message, /3000/);
      assert.match(error.message, /3010/);
      assert.deepEqual(error.details.instances[0].pids, [208]);
      return true;
    }
  );
});

test("an unreachable listener on the target port still blocks a duplicate start", async () => {
  class UnreachableTargetListenerRunner extends TestProjectRunner {
    async isPortOpen() {
      return false;
    }

    async findProjectListeningInstances() {
      return [{
        ports: [3010],
        pids: [301],
        rootPids: [300],
        processes: []
      }];
    }

    async appendLog() {}
  }

  const runner = new UnreachableTargetListenerRunner();
  await assert.rejects(
    () => runner.startProject({
      id: "beauty-training",
      name: "Beauty training",
      type: "cmd",
      command: "this-command-must-not-run",
      allowMultiple: false,
      port: 3010
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "PROJECT_TARGET_LISTENER_UNREACHABLE");
      return true;
    }
  );
});

test("configured project port is injected into the launch environment", () => {
  const env = createProjectEnvironment(
    { id: "boss", port: 3218 },
    { PATH: "test-path", PORT: "3000" },
    "instance-3218"
  );

  assert.equal(env.PORT, "3218");
  assert.equal(env.PROJECT_LAUNCHER_PROJECT_ID, "boss");
  assert.equal(env.PROJECT_LAUNCHER_INSTANCE_ID, "instance-3218");
  assert.equal(env.PATH, "test-path");
});

test("all runnable launch specs use explicit commands without shell pipes", () => {
  const runner = new TestProjectRunner();
  const specs = [
    runner.createLaunchSpec({ type: "exe", path: process.execPath, hideConsole: true }),
    runner.createLaunchSpec({ type: "bat", path: __filename, hideConsole: false }),
    runner.createLaunchSpec({ type: "cmd", command: "node server/index.js", hideConsole: true })
  ];

  for (const spec of specs) {
    assert.equal(spec.shell, false);
    assert.equal(JSON.stringify(spec).includes("pipe"), false);
    assert.equal(Object.hasOwn(spec, "detached"), false);
  }
  if (process.platform === "win32") {
    assert.equal(specs[1].command.toLowerCase(), "cmd.exe");
    assert.equal(specs[2].command.toLowerCase(), "cmd.exe");
    assert.equal(specs[2].args.includes("/c"), true);
  }
});

test("the common independent launcher forces detachment, rejects pipes, and unreferences the child", () => {
  const fakeChild = new EventEmitter();
  let unrefCalls = 0;
  let spawnOptions;
  fakeChild.unref = () => { unrefCalls += 1; };

  const result = spawnIndependentProcess("fake.exe", ["--test"], {
    detached: false,
    stdio: "ignore",
    windowsHide: true
  }, (_command, _args, options) => {
    spawnOptions = options;
    return fakeChild;
  });

  assert.equal(result, fakeChild);
  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.stdio, "ignore");
  assert.equal(unrefCalls, 1);
  assert.throws(
    () => spawnIndependentProcess("fake.exe", [], { stdio: "pipe" }, () => fakeChild),
    /cannot use pipe or IPC/
  );
});

test("a uniquely owned listener can be adopted and persisted as managed runtime", async () => {
  class AdoptRunner extends TestProjectRunner {
    constructor() {
      super();
      this.processes.clear();
      this.livePids = new Set([32180]);
      this.saved = 0;
    }

    async isPortOpen() {
      return true;
    }

    async findPortPids() {
      return [32180];
    }

    classifyProjectPids() {
      return { ownedPids: [32180], foreignPids: [], conflicts: [] };
    }

    getProcessIdentity(pid) {
      return {
        pid,
        name: "node.exe",
        createdAt: 123456,
        executablePath: String.raw`c:\program files\nodejs\node.exe`,
        commandFingerprint: "boss-command"
      };
    }

    isTrackedPidAlive(pid) {
      return this.livePids.has(pid);
    }

    saveRuntimeState() {
      this.saved += 1;
    }

    async appendLog() {}
  }

  const runner = new AdoptRunner();
  const result = await runner.adoptProject({
    id: "recruitment-assistant",
    port: 3218,
    host: "127.0.0.1"
  });

  assert.equal(result.adopted, true);
  assert.equal(result.pid, 32180);
  assert.equal(result.runtime.source, "adopted");
  assert.deepEqual(result.runtime.servicePids, [32180]);
  assert.equal(runner.saved, 1);
});

test("adoption refuses ambiguous process candidates", async () => {
  class AmbiguousAdoptRunner extends TestProjectRunner {
    constructor() {
      super();
      this.processes.clear();
    }

    async isPortOpen() {
      return true;
    }

    async findPortPids() {
      return [32180, 32181];
    }

    classifyProjectPids() {
      return { ownedPids: [32180, 32181], foreignPids: [], conflicts: [] };
    }
  }

  const runner = new AmbiguousAdoptRunner();
  await assert.rejects(
    () => runner.adoptProject({ id: "recruitment-assistant", port: 3218 }),
    /2 个候选进程/
  );
});

test("the current workbench process is recognized without ordinary adoption", async () => {
  class SelfAdoptRunner extends TestProjectRunner {
    constructor() {
      super();
      this.processes.clear();
      this.saved = 0;
    }

    async isPortOpen() {
      return true;
    }

    async findPortPids() {
      return [process.pid];
    }

    classifyProjectPids() {
      return { ownedPids: [process.pid], foreignPids: [], conflicts: [] };
    }

    saveRuntimeState() {
      this.saved += 1;
    }

    async appendLog() {}
  }

  const runner = new SelfAdoptRunner();
  const result = await runner.adoptProject({ id: "project-launcher-workbench", port: 3344 });

  assert.equal(result.selfManaged, true);
  assert.equal(result.alreadyManaged, true);
  assert.equal(result.pid, process.pid);
  assert.equal(result.runtime, null);
  assert.equal(runner.saved, 1);
});

test("inactive failed adoption state can be removed", () => {
  class CleanupRunner extends TestProjectRunner {
    constructor() {
      super();
      this.processes.clear();
      this.saved = 0;
      this.processes.set("self", [{ pid: 99999999, running: false, startedAt: 1 }]);
    }

    saveRuntimeState() {
      this.saved += 1;
    }
  }

  const runner = new CleanupRunner();
  assert.equal(runner.clearInactiveRuntimeState("self"), true);
  assert.equal(runner.getRuntimeState("self"), null);
  assert.equal(runner.saved, 1);
});

test("a managed launch records the real listening service PID", () => {
  const projectId = "service-pid-capture";
  class ServiceCaptureRunner extends TestProjectRunner {
    constructor() {
      super();
      this.processes.clear();
      this.livePids = new Set([41000, 41001]);
      this.processes.set(projectId, [{
        pid: 41000,
        servicePids: [],
        processIdentities: [],
        source: "managed",
        running: true,
        startedAt: Date.now(),
        exitedAt: null,
        stoppedByUser: false,
        stopping: false
      }]);
    }

    isTrackedPidAlive(pid) {
      return this.livePids.has(pid);
    }

    getProcessIdentity(pid) {
      return { pid, createdAt: 1000 + pid, executablePath: "node.exe", commandFingerprint: String(pid) };
    }

    saveRuntimeState() {}
  }

  const runner = new ServiceCaptureRunner();
  assert.equal(runner.trackServicePids(projectId, [41001]), true);
  assert.deepEqual(runner.getRuntimeState(projectId).servicePids, [41001]);
  assert.equal(runner.getRuntimeState(projectId).source, "managed");
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

test("ancestors of an adopted service PID are not treated as external", () => {
  const ancestors = getTrackedAncestorPids(
    [100, 101, 102, 200],
    new Set([103]),
    [
      { pid: 100, parentPid: 1 },
      { pid: 101, parentPid: 100 },
      { pid: 102, parentPid: 101 },
      { pid: 103, parentPid: 102 },
      { pid: 200, parentPid: 1 }
    ]
  );

  assert.deepEqual([...ancestors].sort((a, b) => a - b), [100, 101, 102]);
});

test("stop excludes tracked descendants from external processes", async () => {
  const projectId = "tracked-tree-stop-test";
  const state = {
    pid: 910001,
    running: true,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: 1,
    stoppedByUser: false
  };

  class StopRunner extends TestProjectRunner {
    constructor() {
      super();
      this.processes.set(projectId, [state]);
      this.killedPids = [];
      this.trackedPids = [];
    }

    getRunningStates() {
      return [state];
    }

    getLiveStatePids() {
      return [state.pid];
    }

    isStateAlive() {
      return false;
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
  assert.equal(state.stoppedByUser, true);
  assert.equal(runner.getRuntimeState(projectId).stoppedByUser, true);
});

test("stopping an already exited PID succeeds", async () => {
  await assert.doesNotReject(() => killProcessTree(99999999));
});

test("external process control checks always request a fresh process list", async () => {
  class FreshLookupRunner extends TestProjectRunner {
    async findProjectPids(_project, options) {
      this.lookupOptions = options;
      return [];
    }
  }

  const runner = new FreshLookupRunner();
  await runner.findExternalPids({ detectExternal: true }, new Set());
  assert.deepEqual(runner.lookupOptions, { fresh: true });
});

test("a confirmed unknown port owner can be stopped safely", async () => {
  const listenerPid = 88001;
  class PortOwnerRunner extends TestProjectRunner {
    constructor() {
      super();
      this.killedPids = [];
      this.portOpen = true;
    }

    async isPortOpen() {
      return this.portOpen;
    }

    async findPortPids() {
      return this.portOpen ? [listenerPid] : [];
    }

    classifyProjectPids() {
      return {
        ownedPids: [],
        foreignPids: [listenerPid],
        conflicts: [{
          pid: listenerPid,
          name: "python.exe",
          executablePath: String.raw`C:\Python311\python.exe`,
          commandLine: "python unrelated-server.py"
        }]
      };
    }

    getProcessIdentity(pid) {
      return {
        pid,
        name: "python.exe",
        createdAt: 123456,
        executablePath: String.raw`c:\python311\python.exe`,
        commandFingerprint: "same-process"
      };
    }

    getIndependentProcessRoots(pids) {
      return pids;
    }

    async killProcessTree(pid) {
      this.killedPids.push(pid);
      this.portOpen = false;
    }

    isPidAlive() {
      return this.portOpen;
    }

    async appendLog() {}
  }

  const runner = new PortOwnerRunner();
  const result = await runner.stopPortOwner({
    id: "conflicted-project",
    port: 8023,
    host: "127.0.0.1",
    allowStopExternal: true
  }, {
    expectedPids: [listenerPid],
    projects: []
  });

  assert.deepEqual(runner.killedPids, [listenerPid]);
  assert.deepEqual(result.stoppedPids, [listenerPid]);
  assert.equal(result.ok, true);
});

test("port-owner stop is cancelled when the confirmed PID changed", async () => {
  class ChangedPortOwnerRunner extends TestProjectRunner {
    async isPortOpen() {
      return true;
    }

    async findPortPids() {
      return [88002];
    }

    classifyProjectPids() {
      return {
        ownedPids: [],
        foreignPids: [88002],
        conflicts: [{ pid: 88002, name: "node.exe", commandLine: "node unrelated.js" }]
      };
    }
  }

  const runner = new ChangedPortOwnerRunner();
  await assert.rejects(
    () => runner.stopPortOwner({
      id: "conflicted-project",
      port: 8023,
      allowStopExternal: true
    }, {
      expectedPids: [88001],
      projects: []
    }),
    (error) => error.statusCode === 409 && /PID/.test(error.message)
  );
});

test("a confirmed alternate-port instance is stopped by its verified service root", async () => {
  class AlternateInstanceRunner extends TestProjectRunner {
    constructor() {
      super();
      this.active = true;
      this.killedPids = [];
    }

    async findProjectListeningInstances() {
      return this.active ? [{
        ports: [3000, 6767],
        pids: [208],
        rootPids: [24008],
        processes: [{
          pid: 208,
          parentPid: 24008,
          name: "node.exe",
          commandLine: "next start-server.js"
        }, {
          pid: 24008,
          parentPid: 17396,
          name: "node.exe",
          commandLine: "next dev -p 3000"
        }]
      }] : [];
    }

    getProcessIdentity(pid) {
      return {
        pid,
        name: "node.exe",
        createdAt: 123456,
        executablePath: String.raw`c:\program files\nodejs\node.exe`,
        commandFingerprint: "same-process"
      };
    }

    getIndependentProcessRoots(pids) {
      return pids;
    }

    async killProcessTree(pid) {
      this.killedPids.push(pid);
      this.active = false;
    }

    isPidAlive() {
      return this.active;
    }

    async findPortPids() {
      return this.active ? [208] : [];
    }

    async appendLog() {}
  }

  const runner = new AlternateInstanceRunner();
  const result = await runner.stopAlternateInstances({
    id: "beauty-training",
    name: "Beauty training",
    type: "cmd",
    command: "start",
    port: 3010,
    allowMultiple: false,
    allowStopExternal: true
  }, {
    expectedInstances: [{ ports: [3000, 6767], pids: [208] }],
    projects: []
  });

  assert.deepEqual(runner.killedPids, [24008]);
  assert.deepEqual(result.stoppedPids, [208]);
  assert.deepEqual(result.stoppedRootPids, [24008]);
  assert.deepEqual(result.stoppedPorts, [3000, 6767]);
});

test("alternate-port stop is cancelled when the confirmed listener changed", async () => {
  class ChangedAlternateInstanceRunner extends TestProjectRunner {
    async findProjectListeningInstances() {
      return [{
        ports: [3000],
        pids: [209],
        rootPids: [24009],
        processes: [{ pid: 24009, name: "node.exe", commandLine: "next dev -p 3000" }]
      }];
    }
  }

  const runner = new ChangedAlternateInstanceRunner();
  await assert.rejects(
    () => runner.stopAlternateInstances({
      id: "beauty-training",
      type: "cmd",
      command: "start",
      port: 3010,
      allowMultiple: false,
      allowStopExternal: true
    }, {
      expectedInstances: [{ ports: [3000], pids: [208] }],
      projects: []
    }),
    (error) => error.statusCode === 409 && /PID/.test(error.message)
  );
});

test("restart stops an externally launched project before starting a replacement", async () => {
  class ExternalRestartRunner extends TestProjectRunner {
    constructor() {
      super();
      this.calls = [];
    }

    getRunningStates() {
      return [];
    }

    getTrackedProcessTreePids() {
      return [];
    }

    async findExternalPids() {
      return [88003];
    }

    async stopProject() {
      this.calls.push("stop");
    }

    async startProject() {
      this.calls.push("start");
      return { ok: true };
    }
  }

  const runner = new ExternalRestartRunner();
  const result = await runner.restartProject({ id: "external-project" });

  assert.equal(result.ok, true);
  assert.deepEqual(runner.calls, ["stop", "start"]);
});

test("finished process states release child references and do not accumulate", () => {
  const older = { pid: 10, running: false, startedAt: 100, child: { retained: true } };
  const newer = { pid: 20, running: false, startedAt: 200, child: { retained: true } };

  const compacted = compactProcessStates([older, newer]);

  assert.deepEqual(compacted, [newer]);
  assert.equal(older.child, null);
  assert.equal(newer.child, null);
});

test("running process states replace stale finished history", () => {
  const stopped = { pid: 10, running: false, startedAt: 100, child: { retained: true } };
  const running = { pid: 20, running: true, startedAt: 200, child: { active: true } };

  const compacted = compactProcessStates([stopped, running]);

  assert.deepEqual(compacted, [running]);
  assert.equal(stopped.child, null);
  assert.equal(running.child, null);
});

test('a newly spawned process stays running during the Windows startup grace period', () => {
  class StartupGraceRunner extends TestProjectRunner {
    isStateAlive() {
      return false;
    }

    saveRuntimeState() {}
  }

  const runner = new StartupGraceRunner();
  runner.processes.clear();
  runner.processes.set('startup-grace', [{
    pid: 45000,
    child: { exitCode: null },
    servicePids: [],
    processIdentities: [],
    source: 'managed',
    running: true,
    startedAt: Date.now(),
    stoppedByUser: false
  }]);

  assert.equal(runner.getRuntimeState('startup-grace').running, true);
});

test('a matching live PID recovers a managed state after a transient false exit', () => {
  class RecoveryRunner extends TestProjectRunner {
    isStateAlive() {
      return true;
    }

    getTrackedProcessTreePids(pids) {
      return pids;
    }

    saveRuntimeState() {}
  }

  const runner = new RecoveryRunner();
  runner.processes.clear();
  runner.processes.set('recover-managed', [{
    pid: 46000,
    child: null,
    servicePids: [],
    processIdentities: [],
    source: 'managed',
    running: false,
    startedAt: Date.now() - 10000,
    exitedAt: Date.now() - 9000,
    stoppedByUser: false
  }]);

  const runtime = runner.getRuntimeState('recover-managed');
  assert.equal(runtime.running, true);
  assert.equal(runtime.exitedAt, null);
});

test("a managed service instance survives runtime reload after its launcher root exits", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-runner-runtime-"));
  const runtimeStatePath = path.join(tempDir, "runtime-state.json");
  const projectId = "restored-independent-service";
  const servicePid = 62001;
  const serviceIdentity = {
    pid: servicePid,
    name: "node.exe",
    createdAt: 123456789,
    executablePath: process.execPath,
    commandFingerprint: "persistent-service"
  };

  class RestoreRunner extends ProjectRunner {
    scheduleManagedProcessCapture() {}

    isPidAlive(pid) {
      return pid === servicePid;
    }

    getProcessIdentity(pid) {
      return pid === servicePid ? serviceIdentity : null;
    }

    getTrackedProcessTreePids(pids) {
      return [...pids];
    }
  }

  try {
    const writer = new RestoreRunner({ runtimeStatePath, loadRuntimeState: false });
    writer.processes.set(projectId, [{
      instanceId: "persistent-instance",
      pid: 91919191,
      child: null,
      servicePids: [servicePid],
      processIdentities: [serviceIdentity],
      identityRequired: true,
      source: "managed",
      running: true,
      startedAt: Date.now() - 1000,
      launchConfirmedAt: Date.now() - 1000,
      exitedAt: null,
      stoppedByUser: false,
      stopping: false
    }]);
    writer.saveRuntimeState();

    let spawnCalls = 0;
    const restored = new RestoreRunner({
      runtimeStatePath,
      spawnProcess() {
        spawnCalls += 1;
        throw new Error("restored project must not spawn again");
      }
    });
    const runtime = restored.getRuntimeState(projectId);
    assert.equal(runtime.running, true);
    assert.equal(runtime.source, "managed");
    assert.equal(runtime.instances[0].instanceId, "persistent-instance");
    assert.equal(runtime.rootPids.includes(servicePid), true);

    const startResult = await restored.startProject({
      id: projectId,
      type: "cmd",
      command: "this-command-must-not-run",
      allowMultiple: false
    });
    assert.equal(startResult.alreadyRunning, true);
    assert.equal(spawnCalls, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a reused PID with a mismatched identity is never sent to the stop command", async () => {
  const reusedPid = 63001;
  const currentIdentity = {
    pid: reusedPid,
    name: "node.exe",
    createdAt: 900000,
    executablePath: process.execPath,
    commandFingerprint: "replacement-process"
  };
  const state = {
    instanceId: "stale-instance",
    pid: reusedPid,
    child: null,
    servicePids: [],
    processIdentities: [{
      ...currentIdentity,
      createdAt: currentIdentity.createdAt - 60000,
      commandFingerprint: "original-process"
    }],
    identityRequired: true,
    source: "managed",
    running: true,
    startedAt: Date.now() - 60000,
    exitedAt: null,
    stoppedByUser: false,
    stopping: false
  };

  class SafeStopRunner extends TestProjectRunner {
    constructor() {
      super();
      this.killedPids = [];
      this.processes.set("stale-project", [state]);
    }

    async killProcessTree(pid) {
      this.killedPids.push(pid);
    }

    isPidAlive(pid) {
      return pid === reusedPid;
    }

    getProcessIdentity(pid) {
      return pid === reusedPid ? currentIdentity : null;
    }

    saveRuntimeState() {}
    async appendLog() {}
  }

  const runner = new SafeStopRunner();
  await assert.rejects(
    () => runner.stopProject({ id: "stale-project", detectExternal: false }),
    /没有可停止的运行中进程/
  );
  assert.deepEqual(runner.killedPids, []);
});

test('managed process-tree capture keeps descendants assigned to their own instances', () => {
  class ManagedTreeRunner extends TestProjectRunner {
    getProcessMemoryInfo(pids) {
      if (pids.includes(47000)) return { pids: [47000, 47001] };
      if (pids.includes(48000)) return { pids: [48000, 48001] };
      return { pids: [] };
    }

    getProcessIdentity(pid) {
      return {
        pid,
        name: pid % 1000 === 0 ? 'cmd.exe' : 'python.exe',
        createdAt: 1000 + pid,
        executablePath: String(pid),
        commandFingerprint: String(pid)
      };
    }

    saveRuntimeState() {}
  }

  const runner = new ManagedTreeRunner();
  runner.processes.clear();
  const states = [47000, 48000].map((pid) => ({
    pid,
    child: null,
    servicePids: [],
    processIdentities: [],
    source: 'managed',
    running: true,
    startedAt: Date.now(),
    stoppedByUser: false
  }));
  runner.processes.set('multi-tree', states);

  assert.equal(runner.captureManagedProcessTrees('multi-tree'), true);
  assert.deepEqual(states[0].servicePids, [47001]);
  assert.deepEqual(states[1].servicePids, [48001]);
  assert.equal(runner.getRuntimeState('multi-tree').runningCount, 2);
});

test("multi-instance launches are independent and retain only scalar runtime state", async () => {
  const spawnCalls = [];
  let nextPid = 61000;
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid;
    nextPid += 1;
    child.unrefCalls = 0;
    child.unref = () => { child.unrefCalls += 1; };
    spawnCalls.push({ command, args, options, child });
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  class MultiLaunchRunner extends TestProjectRunner {
    constructor() {
      super({ spawnProcess });
    }

    openProjectOutput() {
      return { stdio: "ignore", close() {} };
    }

    getProcessIdentity(pid) {
      return {
        pid,
        name: "node.exe",
        createdAt: Date.now(),
        executablePath: process.execPath,
        commandFingerprint: `instance-${pid}`
      };
    }

    isTrackedPidAlive(pid, state) {
      return state.processIdentities.some((identity) => identity.pid === pid);
    }

    getTrackedProcessTreePids(pids) {
      return [...pids];
    }

    scheduleManagedProcessCapture() {}
    saveRuntimeState() {}
    async appendLog() {}
  }

  const runner = new MultiLaunchRunner();
  const project = {
    id: "independent-multi",
    type: "exe",
    path: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    allowMultiple: true,
    hideConsole: true
  };

  await runner.startProject(project);
  await runner.startProject(project);

  const states = runner.getRunningStates(project.id);
  const runtime = runner.getRuntimeState(project.id);
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls.every((call) => call.options.detached === true), true);
  assert.equal(spawnCalls.every((call) => JSON.stringify(call.options.stdio).includes("pipe") === false), true);
  assert.equal(spawnCalls.every((call) => call.child.unrefCalls === 1), true);
  assert.equal(states.every((state) => state.child === null), true);
  assert.equal(new Set(states.map((state) => state.instanceId)).size, 2);
  assert.equal(runtime.runningCount, 2);
  assert.equal(new Set(runtime.instances.map((instance) => instance.instanceId)).size, 2);
});

test("project stop waits for both PIDs and the configured port to settle", async () => {
  let pidChecks = 0;
  let portChecks = 0;

  const settled = await waitForProjectStop({ port: 3344, host: "127.0.0.1" }, [101], {
    timeoutMs: 1000,
    pollIntervalMs: 1,
    isPidAlive() {
      pidChecks += 1;
      return pidChecks < 3;
    },
    async isPortOpen() {
      portChecks += 1;
      return portChecks < 4;
    },
    async delay() {}
  });

  assert.equal(settled, true);
  assert.equal(pidChecks, 4);
  assert.equal(portChecks, 4);
});

test("project state remains stopping until process termination settles", async () => {
  const state = {
    pid: 910010,
    running: true,
    stopping: false,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    stoppedByUser: false
  };
  let signalKillStarted;
  let finishKill;
  const killStarted = new Promise((resolve) => {
    signalKillStarted = resolve;
  });

  class StoppingRunner extends TestProjectRunner {
    getRunningStates() {
      return [state];
    }

    getLiveStatePids() {
      return [state.pid];
    }

    isStateAlive() {
      return false;
    }

    getTrackedProcessTreePids() {
      return [state.pid];
    }

    async findExternalPids() {
      return [];
    }

    getIndependentProcessRoots(pids) {
      return pids;
    }

    async killProcessTree() {
      signalKillStarted();
      await new Promise((resolve) => {
        finishKill = resolve;
      });
    }

    async waitForProjectStop() {
      return true;
    }

    async appendLog() {}
    saveRuntimeState() {}
  }

  const runner = new StoppingRunner();
  const stopPromise = runner.stopProject({ id: "stopping-state-test" });
  await killStarted;

  assert.equal(state.stopping, true);
  assert.equal(state.stoppedByUser, true);

  finishKill();
  await stopPromise;

  assert.equal(state.stopping, false);
  assert.equal(state.running, false);
});

test("start is blocked when the configured port belongs to another project", async () => {
  class ConflictRunner extends TestProjectRunner {
    async isPortOpen() {
      return true;
    }

    async findPortPids() {
      return [25820];
    }

    classifyProjectPids(_project, pids, options) {
      assert.deepEqual(pids, [25820]);
      assert.equal(options.knownProjects[0].id, "BeautyTraining");
      return {
        ownedPids: [],
        foreignPids: [25820],
        conflicts: [{ pid: 25820, name: "node.exe", ownerProjectName: "美业AI本地测试" }]
      };
    }
  }

  const runner = new ConflictRunner();
  await assert.rejects(() => runner.startProject({
    id: "boss-conflict-start-test",
    name: "BOSS招聘助手",
    type: "cmd",
    command: "this-command-must-not-run",
    port: 3000
  }, {
    projects: [{ id: "BeautyTraining", name: "美业AI本地测试" }]
  }), /端口 3000 已被 美业AI本地测试（PID 25820）占用，无法启动/);
});

test("external process discovery excludes foreign port owners", async () => {
  class OwnershipRunner extends TestProjectRunner {
    async findPortPids() {
      return [991001, 991002];
    }

    classifyProjectPids(_project, pids, options) {
      assert.deepEqual(pids, [991001, 991002]);
      assert.equal(options.fresh, true);
      return {
        ownedPids: [991001],
        foreignPids: [991002],
        conflicts: [{ pid: 991002, name: "node.exe" }]
      };
    }

    async findProjectPids() {
      return [991003];
    }
  }

  const runner = new OwnershipRunner();
  const pids = await runner.findExternalPids({ port: 3000, detectExternal: true }, new Set());
  assert.deepEqual(pids, [991001, 991003]);
});

test("start fails closed when an open port owner cannot be identified", async () => {
  class UnknownPortOwnerRunner extends TestProjectRunner {
    async isPortOpen() {
      return true;
    }

    async findPortPids() {
      return [];
    }

    classifyProjectPids() {
      return { ownedPids: [], foreignPids: [], conflicts: [] };
    }
  }

  const runner = new UnknownPortOwnerRunner();
  await assert.rejects(() => runner.startProject({
    id: "unknown-port-owner-test",
    type: "cmd",
    command: "this-command-must-not-run",
    port: 3000
  }), /端口 3000 已被 未知进程占用，无法启动/);
});
test("stop settlement ignores a port that remains owned only by a foreign process", async () => {
  class ForeignPortRunner extends TestProjectRunner {
    async isPortOpen() {
      return true;
    }

    async findPortPids() {
      return [991100];
    }

    classifyProjectPids(_project, pids, options) {
      assert.deepEqual(pids, [991100]);
      assert.equal(options.runtimePids.has(991099), true);
      return {
        ownedPids: [],
        foreignPids: [991100],
        conflicts: [{ pid: 991100, name: "node.exe" }]
      };
    }
  }

  const runner = new ForeignPortRunner();
  const settled = await runner.waitForProjectStop({ port: 3000 }, [991099], {
    timeoutMs: 100,
    pollIntervalMs: 1,
    isPidAlive: () => false,
    async delay() {}
  });

  assert.equal(settled, true);
});

test("an independently launched process survives after its launcher process exits", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-runner-detached-"));
  const pidFile = path.join(tempDir, "target.pid");
  const heartbeatFile = path.join(tempDir, "heartbeat.log");
  const stopFile = path.join(tempDir, "stop");
  const modulePath = path.resolve(__dirname, "../server/project-runner.js");
  const targetScript = [
    `const fs = require(${JSON.stringify("node:fs")});`,
    `const stopFile = ${JSON.stringify(stopFile)};`,
    `console.log("started");`,
    `setInterval(() => {`,
    `if (fs.existsSync(stopFile)) process.exit(0);`,
    `console.log(Date.now());`,
    `}, 50);`
  ].join("");
  const launcherScript = [
    `const fs = require(${JSON.stringify("node:fs")});`,
    `const { spawnIndependentProcess } = require(${JSON.stringify(modulePath)});`,
    `const outputFd = fs.openSync(${JSON.stringify(heartbeatFile)}, "a");`,
    `const child = spawnIndependentProcess(process.execPath, ["-e", ${JSON.stringify(targetScript)}], {`,
    `cwd: ${JSON.stringify(process.cwd())}, windowsHide: true, stdio: ["ignore", outputFd, outputFd]`,
    `});`,
    `fs.closeSync(outputFd);`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`
  ].join("");

  let targetPid = null;
  try {
    const launcher = spawn(process.execPath, ["-e", launcherScript], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "ignore"
    });
    const [code, signal] = await once(launcher, "exit");
    assert.equal(code, 0, `launcher exited with code=${code} signal=${signal || ""}`);
    await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(heartbeatFile));

    targetPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(Number.isInteger(targetPid) && targetPid > 0, true);
    assert.doesNotThrow(() => process.kill(targetPid, 0));

    const firstSize = fs.statSync(heartbeatFile).size;
    await waitFor(() => fs.statSync(heartbeatFile).size > firstSize, 3000);
    assert.doesNotThrow(() => process.kill(targetPid, 0));
  } finally {
    try {
      if (targetPid) {
        fs.writeFileSync(stopFile, "stop", "utf8");
        await waitFor(() => {
          try {
            process.kill(targetPid, 0);
            return false;
          } catch {
            return true;
          }
        }, 3000);
      }
    } catch {
      if (targetPid) await killProcessTree(targetPid).catch(() => {});
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("the project Codex action only launches the CLI in its configured directory", async () => {
  class CodexLaunchRunner extends TestProjectRunner {
    constructor() {
      super();
      this.processes.clear();
      this.steps = [];
    }

    async openCodexCli(cwd) {
      this.steps.push(`cli:${cwd}`);
    }

    async appendLog() {}
  }

  const runner = new CodexLaunchRunner();
  const result = await runner.openCodex({
    id: "codex-launch-test",
    codexCwd: process.cwd()
  });

  assert.deepEqual(runner.steps, [`cli:${process.cwd()}`]);
  assert.equal(result.codexAction, "opened");
});

test("the standalone Codex desktop action returns launch details", async () => {
  class CodexDesktopRunner extends TestProjectRunner {
    async openCodexDesktop() {
      return { ok: true, action: "started", pid: 55001 };
    }
  }

  const runner = new CodexDesktopRunner();
  const result = await runner.openCodexDesktopApp();

  assert.equal(result.desktopAction, "started");
  assert.equal(result.desktopPid, 55001);
  assert.match(result.message, /ChatGPT\/Codex/);
});
