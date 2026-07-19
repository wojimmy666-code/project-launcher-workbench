const assert = require("node:assert/strict");
const test = require("node:test");
const {
  addMemorySample,
  checkProjectStatus,
  classifyProjectPids,
  getManagementState,
  getProcessMemoryInfo,
  processIdentityMatches,
  processLineageMatchesProject
} = require("../server/status-checker");

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

test("persisted process identity rejects a reused PID", () => {
  const expected = {
    pid: 700,
    createdAt: 1000,
    executablePath: String.raw`c:\program files\nodejs\node.exe`,
    commandFingerprint: "original"
  };

  assert.equal(processIdentityMatches(expected, { ...expected }), true);
  assert.equal(processIdentityMatches(expected, { ...expected, createdAt: 5000 }), false);
  assert.equal(processIdentityMatches(expected, { ...expected, commandFingerprint: "replacement" }), false);
  assert.equal(processIdentityMatches(
    { pid: 42, executablePath: "powershell.exe" },
    { pid: 42, executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }
  ), true);
});

test('managed and external instances are reported as mixed ownership', () => {
  assert.equal(getManagementState({ running: true, source: 'managed' }, [701]), 'mixed');
  assert.equal(getManagementState({ running: true, source: 'managed' }, []), 'managed');
  assert.equal(getManagementState({ running: false }, [701]), 'external');
});

test("the workbench process does not absorb projects it launched", () => {
  const result = getProcessMemoryInfo([100], {
    platform: "win32",
    currentPid: 100,
    trackHistory: false,
    processes: [
      { ProcessId: 100, ParentProcessId: 1, Name: "node.exe", WorkingSetSize: 50, PrivatePageCount: 60 },
      { ProcessId: 200, ParentProcessId: 100, Name: "cmd.exe", WorkingSetSize: 20, PrivatePageCount: 30 },
      { ProcessId: 201, ParentProcessId: 200, Name: "python.exe", WorkingSetSize: 200, PrivatePageCount: 220 }
    ]
  });

  assert.equal(result.processCount, 1);
  assert.deepEqual(result.pids, [100]);
  assert.equal(result.workingSetBytes, 50);
  assert.equal(result.privateBytes, 60);
});

test("frequent observations still create one memory sample per interval", () => {
  const entry = { samples: [] };

  for (let at = 0; at <= 65000; at += 5000) {
    addMemorySample(entry, {
      at,
      privateBytes: 100 + at,
      workingSetBytes: 200 + at
    });
  }

  assert.deepEqual(entry.samples.map((sample) => sample.at), [0, 30000, 60000]);
  assert.equal(entry.samples[0].privateBytes, 25100);
  assert.equal(entry.samples[1].privateBytes, 55100);
  assert.equal(entry.samples[2].privateBytes, 65100);
});
test("stopping state takes precedence over a still-running process", async () => {
  const result = await checkProjectStatus(project, {
    running: true,
    stopping: true,
    pids: [],
    startedAt: Date.now()
  });

  assert.equal(result.state, "stopping");
  assert.equal(result.message, "\u6b63\u5728\u505c\u6b62\u9879\u76ee");
});

test("a foreign listener is reported as a conflict with its known project owner", () => {
  const boss = {
    id: "recruitment-assistant",
    name: "BOSS招聘助手",
    cwd: String.raw`D:\Projects\recruitment-assistant`,
    command: String.raw`D:\Projects\recruitment-assistant\scripts\start-server.bat`
  };
  const beauty = {
    id: "BeautyTraining",
    name: "美业AI本地测试",
    codexCwd: String.raw`D:\Projects\BeautyTraining`,
    path: String.raw`D:\Projects\BeautyTraining\scripts\start-menu.bat`
  };
  const result = classifyProjectPids(boss, [25820], {
    knownProjects: [boss, beauty],
    processes: [{
      ProcessId: 25820,
      ParentProcessId: 100,
      Name: "node.exe",
      ExecutablePath: String.raw`C:\Program Files\nodejs\node.exe`,
      CommandLine: String.raw`"node.exe" D:\Projects\BeautyTraining\node_modules\next\dist\server\lib\start-server.js`
    }]
  });

  assert.deepEqual(result.ownedPids, []);
  assert.deepEqual(result.foreignPids, [25820]);
  assert.equal(result.conflicts[0].ownerProjectId, "BeautyTraining");
  assert.equal(result.conflicts[0].ownerProjectName, "美业AI本地测试");
});

test("a managed listener is rechecked with a fresh process tree before startup conflict", async () => {
  const listenerPid = 990001;
  const classifierCalls = [];
  const staleOwnership = {
    ownedPids: [],
    foreignPids: [listenerPid],
    conflicts: [{
      pid: listenerPid,
      name: "python.exe",
      executablePath: String.raw`C:\Python311\python.exe`,
      commandLine: "python -m analysis_lab.cli --serve --port 8023"
    }]
  };
  const freshOwnership = {
    ownedPids: [listenerPid],
    foreignPids: [],
    conflicts: []
  };

  const result = await checkProjectStatus({
    id: "Polymarket-TempPath",
    path: String.raw`D:\Projects\PolymarketBots\strategy\temperature_path\scripts\start_server.bat`,
    host: "127.0.0.1",
    port: 8023
  }, {
    running: true,
    source: "managed",
    pids: [990000],
    startedAt: 1000
  }, {
    now: 2000,
    isPortOpen: async () => true,
    findPortPids: async () => [listenerPid],
    classifyProjectPids(_project, _pids, options) {
      classifierCalls.push(options.fresh === true);
      return options.fresh === true ? freshOwnership : staleOwnership;
    }
  });

  assert.deepEqual(classifierCalls, [false, true]);
  assert.equal(result.state, "running");
  assert.deepEqual(result.ownedPortPids, [listenerPid]);
  assert.deepEqual(result.conflictPids, []);
});

test("a real foreign listener remains a conflict after the startup recheck", async () => {
  const listenerPid = 990002;
  const classifierCalls = [];
  const foreignOwnership = {
    ownedPids: [],
    foreignPids: [listenerPid],
    conflicts: [{
      pid: listenerPid,
      name: "node.exe",
      executablePath: String.raw`C:\Program Files\nodejs\node.exe`,
      commandLine: "node unrelated-server.js"
    }]
  };

  const result = await checkProjectStatus({
    id: "Polymarket-TempPath",
    path: String.raw`D:\Projects\PolymarketBots\strategy\temperature_path\scripts\start_server.bat`,
    host: "127.0.0.1",
    port: 8023,
    allowStopExternal: true
  }, {
    running: true,
    source: "managed",
    pids: [990000],
    startedAt: 1000
  }, {
    now: 2000,
    isPortOpen: async () => true,
    findPortPids: async () => [listenerPid],
    classifyProjectPids(_project, _pids, options) {
      classifierCalls.push(options.fresh === true);
      return foreignOwnership;
    }
  });

  assert.deepEqual(classifierCalls, [false, true]);
  assert.equal(result.state, "conflict");
  assert.deepEqual(result.conflictPids, [listenerPid]);
  assert.equal(result.canStopConflict, true);
});

test("a listener whose parent command belongs to the project is owned", () => {
  const target = {
    cwd: String.raw`D:\Projects\recruitment-assistant`,
    command: String.raw`D:\Projects\recruitment-assistant\scripts\start-server.bat`
  };
  const result = classifyProjectPids(target, [500], {
    processes: [
      { ProcessId: 500, ParentProcessId: 499, Name: "node.exe", CommandLine: "node server.js" },
      {
        ProcessId: 499,
        ParentProcessId: 1,
        Name: "cmd.exe",
        CommandLine: String.raw`cmd /c D:\Projects\recruitment-assistant\scripts\start-server.bat`
      }
    ]
  });

  assert.deepEqual(result.ownedPids, [500]);
  assert.deepEqual(result.foreignPids, []);
});

test("a runtime-tracked listener remains owned when command metadata is unavailable", () => {
  const result = classifyProjectPids({ cwd: String.raw`D:\Projects\target` }, [700], {
    runtimePids: new Set([700]),
    processes: [{ ProcessId: 700, ParentProcessId: 1, Name: "node.exe", CommandLine: "" }]
  });

  assert.deepEqual(result.ownedPids, [700]);
  assert.deepEqual(result.foreignPids, []);
});

test("the current backend listener is owned even when its command uses a relative path", () => {
  const currentPid = 12092;
  const result = classifyProjectPids({
    id: "project-launcher-workbench",
    cwd: String.raw`D:\Projects\project-launcher-workbench`,
    command: String.raw`D:\Projects\project-launcher-workbench\start-workbench.bat`
  }, [currentPid], {
    currentPid,
    processes: [{
      ProcessId: currentPid,
      ParentProcessId: 1,
      Name: "node.exe",
      ExecutablePath: String.raw`D:\Program Files\nodejs\node.exe`,
      CommandLine: String.raw`node.exe server\index.js`
    }]
  });

  assert.deepEqual(result.ownedPids, [currentPid]);
  assert.deepEqual(result.foreignPids, []);
  assert.deepEqual(result.conflicts, []);
});

test("the workbench ancestor does not claim processes launched for other projects", () => {
  const childPid = process.pid + 100000;
  const byPid = new Map([
    [childPid, { ProcessId: childPid, ParentProcessId: process.pid, Name: "node.exe", CommandLine: "node other-project.js" }],
    [process.pid, {
      ProcessId: process.pid,
      ParentProcessId: 1,
      Name: "node.exe",
      CommandLine: String.raw`node D:\Projects\project-launcher-workbench\server\index.js`
    }]
  ]);

  assert.equal(processLineageMatchesProject({
    cwd: String.raw`D:\Projects\project-launcher-workbench`
  }, childPid, byPid), false);
});

test("a Codex session opened in a project directory is not treated as the project service", () => {
  const target = {
    path: "D:\\Projects\\BeautyTraining\\scripts\\start-menu.bat"
  };
  const powershellPid = 2328;
  const codexNodePid = 13236;
  const codexPid = 16028;
  const mcpPid = 13680;
  const byPid = new Map([
    [powershellPid, {
      ProcessId: powershellPid,
      ParentProcessId: 1,
      Name: "powershell.exe",
      CommandLine: "powershell.exe -NoExit -Command \"Set-Location -LiteralPath 'D:\\Projects\\BeautyTraining'; codex\""
    }],
    [codexNodePid, {
      ProcessId: codexNodePid,
      ParentProcessId: powershellPid,
      Name: "node.exe",
      CommandLine: "node.exe C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"
    }],
    [codexPid, {
      ProcessId: codexPid,
      ParentProcessId: codexNodePid,
      Name: "codex.exe",
      CommandLine: "codex.exe"
    }],
    [mcpPid, {
      ProcessId: mcpPid,
      ParentProcessId: codexPid,
      Name: "node.exe",
      CommandLine: "node.exe ./mcp/server.mjs"
    }]
  ]);

  for (const pid of [powershellPid, codexNodePid, codexPid, mcpPid]) {
    assert.equal(processLineageMatchesProject(target, pid, byPid), false);
  }
});

test("a project server launched from Codex still matches by its own command line", () => {
  const target = {
    path: "D:\\Projects\\BeautyTraining\\scripts\\start-menu.bat"
  };
  const codexPid = 16028;
  const serverPid = 34384;
  const byPid = new Map([
    [codexPid, {
      ProcessId: codexPid,
      ParentProcessId: 1,
      Name: "codex.exe",
      CommandLine: "codex.exe"
    }],
    [serverPid, {
      ProcessId: serverPid,
      ParentProcessId: codexPid,
      Name: "node.exe",
      CommandLine: "node.exe D:\\Projects\\BeautyTraining\\node_modules\\next\\dist\\server\\lib\\start-server.js"
    }]
  ]);

  assert.equal(processLineageMatchesProject(target, serverPid, byPid), true);
});

test("processMatch identifies a generic project server launched below Codex", () => {
  const target = {
    processMatch: ["analysis_lab.cli", "--port 8023"]
  };
  const server = {
    ProcessId: 42001,
    ParentProcessId: 42000,
    Name: "python.exe",
    ExecutablePath: String.raw`C:\Python311\python.exe`,
    CommandLine: "python -m analysis_lab.cli --serve --port 8023"
  };
  const codex = {
    ProcessId: 42000,
    ParentProcessId: 1,
    Name: "codex.exe",
    CommandLine: "codex.exe"
  };
  const byPid = new Map([[server.ProcessId, server], [codex.ProcessId, codex]]);

  assert.equal(processLineageMatchesProject(target, server.ProcessId, byPid), true);
  assert.equal(processLineageMatchesProject(
    { processMatch: ["analysis_lab.cli", "--port 9999"] },
    server.ProcessId,
    byPid
  ), false);
});

test("projects sharing a repository root do not claim sibling strategy processes", () => {
  const target = {
    path: String.raw`D:\Projects\PolymarketBots\strategy\temperature\run_trader.bat`,
    codexCwd: String.raw`D:\Projects\PolymarketBots`
  };
  const siblingPid = 880;
  const byPid = new Map([[siblingPid, {
    ProcessId: siblingPid,
    ParentProcessId: 1,
    Name: "python.exe",
    CommandLine: String.raw`python D:\Projects\PolymarketBots\strategy\temperature_path\server.py`
  }]]);

  assert.equal(processLineageMatchesProject(target, siblingPid, byPid), false);
});
