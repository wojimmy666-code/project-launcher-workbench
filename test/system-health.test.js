const assert = require("node:assert/strict");
const test = require("node:test");
const { checkSystemHealth } = require("../server/system-health");

test("concurrent system health requests share one in-flight probe", async () => {
  let httpCalls = 0;
  let externalCalls = 0;
  let finishExternal;
  const externalPending = new Promise((resolve) => { finishExternal = resolve; });
  const dependencies = {
    checkHttpTarget: async () => {
      httpCalls += 1;
      return { state: "ok", label: "connected" };
    },
    checkExternalConnectivity: async () => {
      externalCalls += 1;
      await externalPending;
      return { state: "ok", label: "proxy" };
    }
  };

  const first = checkSystemHealth({ server: { port: 3344 } }, dependencies);
  const second = checkSystemHealth({ server: { port: 3344 } }, dependencies);
  assert.equal(first, second);
  assert.equal(httpCalls, 1);
  assert.equal(externalCalls, 1);

  finishExternal();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(left.server.state, "ok");
});

test("system health starts a new probe after the shared request settles", async () => {
  let calls = 0;
  const dependencies = {
    checkHttpTarget: async () => ({ state: "ok", label: "connected" }),
    checkExternalConnectivity: async () => {
      calls += 1;
      return { state: "ok", label: "proxy" };
    }
  };

  await checkSystemHealth({}, dependencies);
  await checkSystemHealth({}, dependencies);
  assert.equal(calls, 2);
});
