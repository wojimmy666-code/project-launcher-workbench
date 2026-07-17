const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const {
  checkExternalConnectivity,
  parseNetstatListeners,
  parseProxyUrl,
  probeSocks5Protocol,
  resetExternalConnectivityState
} = require("../server/proxy-connectivity");

test("proxy URLs support dynamic SOCKS and HTTP endpoints", () => {
  assert.deepEqual(parseProxyUrl("socks5h://127.0.0.1:10808", "manual"), {
    kind: "proxy",
    protocol: "socks5",
    host: "127.0.0.1",
    port: 10808,
    username: "",
    password: "",
    source: "manual"
  });
  assert.equal(parseProxyUrl("127.0.0.1:7890").protocol, "http");
  assert.equal(parseProxyUrl("ftp://127.0.0.1:21"), null);
});

test("listener discovery uses actual loopback listeners instead of fixed ports", () => {
  const output = [
    "TCP    127.0.0.1:45678    0.0.0.0:0    LISTENING    101",
    "TCP    0.0.0.0:23456      0.0.0.0:0    LISTENING    102",
    "TCP    192.168.1.5:34567  0.0.0.0:0    LISTENING    103",
    "TCP    127.0.0.1:45678    0.0.0.0:0    LISTENING    101"
  ].join("\r\n");
  const result = parseNetstatListeners(output, { excludePorts: new Set([23456]) });
  assert.deepEqual(result, [{ host: "127.0.0.1", port: 45678, pid: 101 }]);
});

test("SOCKS5 protocol is identified by handshake, independent of port number", async (t) => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(Buffer.from([5, 0])));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  assert.equal(await probeSocks5Protocol({ host: "127.0.0.1", port }, 1000), true);
});

test("auto mode reports a dynamically discovered working proxy", async () => {
  resetExternalConnectivityState();
  const result = await checkExternalConnectivity({ mode: "auto", targets: ["https://example.test/health"] }, {
    now: () => 1000,
    testRoute: async () => ({ ok: false, message: "direct failed" }),
    getConfiguredProxyCandidates: async () => [],
    discoverLocalProxyCandidates: async () => [{ host: "127.0.0.1", port: 45678, pid: 77 }],
    findWorkingLocalProxy: async () => ({
      ok: true,
      route: { kind: "proxy", protocol: "socks5", source: "auto", host: "127.0.0.1", port: 45678, pid: 77 },
      target: "https://example.test/health",
      statusCode: 204,
      latencyMs: 25
    }),
    getProcessName: async () => "proxy-core.exe"
  });
  assert.equal(result.state, "ok");
  assert.equal(result.label, "代理连通");
  assert.equal(result.proxyEndpoint, "127.0.0.1:45678");
  assert.equal(result.proxyPid, 77);
});

test("a recent successful route is not marked down on the first transient failure", async () => {
  resetExternalConnectivityState();
  let succeeds = true;
  const dependencies = {
    now: () => 1000,
    testRoute: async () => succeeds
      ? { ok: true, target: "https://example.test/health", statusCode: 204, latencyMs: 10 }
      : { ok: false, message: "temporary failure" },
    getConfiguredProxyCandidates: async () => [],
    discoverLocalProxyCandidates: async () => [],
    findWorkingLocalProxy: async () => ({ ok: false, message: "none" })
  };
  const config = { mode: "auto", targets: ["https://example.test/health"], failureThreshold: 2 };
  assert.equal((await checkExternalConnectivity(config, dependencies)).state, "ok");
  succeeds = false;
  assert.equal((await checkExternalConnectivity(config, dependencies)).label, "复检中");
  assert.equal((await checkExternalConnectivity(config, dependencies)).label, "不可达");
});
