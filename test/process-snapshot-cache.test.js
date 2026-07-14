const assert = require("node:assert/strict");
const test = require("node:test");
const { ProcessSnapshotCache } = require("../server/process-snapshot-cache");

test("fresh process reads bypass the dashboard snapshot cache", () => {
  const cache = new ProcessSnapshotCache(60000);
  let version = 0;
  const load = () => [{ pid: ++version }];

  assert.deepEqual(cache.get(load, { now: 1000 }), [{ pid: 1 }]);
  assert.deepEqual(cache.get(load, { now: 2000 }), [{ pid: 1 }]);
  assert.deepEqual(cache.get(load, { fresh: true, now: 3000 }), [{ pid: 2 }]);
  assert.deepEqual(cache.get(load, { now: 4000 }), [{ pid: 1 }]);

  cache.invalidate();
  assert.deepEqual(cache.get(load, { now: 5000 }), [{ pid: 3 }]);
});
