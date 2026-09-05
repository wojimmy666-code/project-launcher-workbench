const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const {
  partitionProjectListeningInstances,
  resolveProjectAuxiliaryPorts,
  resolveProjectPort,
  resolveProjectPorts
} = require("../server/project-port");
const { checkProjectStatus } = require("../server/status-checker");

test("explicit project port takes precedence over URL port", () => {
  assert.equal(resolveProjectPort({ port: 4100, url: "http://localhost:3000/" }), 4100);
});

test("project port is inferred from an explicit URL port", () => {
  assert.equal(resolveProjectPort({ url: "http://localhost:3000/" }), 3000);
  assert.equal(resolveProjectPort({ url: "https://localhost:8443/path" }), 8443);
});

test("project port is not inferred when URL has no explicit port", () => {
  assert.equal(resolveProjectPort({ url: "http://localhost/" }), null);
  assert.equal(resolveProjectPort({ url: "invalid" }), null);
});

test("project ports distinguish primary and auxiliary services", () => {
  const project = { port: 4174, auxiliaryPorts: [8000, "8001", 4174, 0] };
  assert.deepEqual(resolveProjectAuxiliaryPorts(project), [8000, 8001]);
  assert.deepEqual(resolveProjectPorts(project), [4174, 8000, 8001]);
});

test("listening instances are partitioned into target, auxiliary, and alternate groups", () => {
  const target = { ports: [4174], pids: [1] };
  const auxiliary = { ports: [8000], pids: [2] };
  const alternate = { ports: [4173], pids: [3] };
  const result = partitionProjectListeningInstances(
    { port: 4174, auxiliaryPorts: [8000] },
    [alternate, auxiliary, target]
  );

  assert.deepEqual(result.targetInstances, [target]);
  assert.deepEqual(result.auxiliaryInstances, [auxiliary]);
  assert.deepEqual(result.alternateInstances, [alternate]);
});

test("status checker uses the URL port when explicit port is missing", async (t) => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const result = await checkProjectStatus({
    url: "http://127.0.0.1:" + address.port + "/",
    host: "127.0.0.1",
    detectExternal: false
  }, {
    running: true,
    pids: [process.pid],
    startedAt: Date.now()
  });

  assert.equal(result.state, "running");
});
