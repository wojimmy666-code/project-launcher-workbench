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

test("invalidating a process snapshot keeps it available only as stale fallback", () => {
  const cache = new ProcessSnapshotCache(1000);
  const processes = [{ pid: 42 }];

  cache.set(processes, { now: 100 });
  assert.equal(cache.isFresh(200), true);
  assert.equal(cache.peek({ now: 200 }), processes);

  cache.invalidate();
  assert.equal(cache.isFresh(200), false);
  assert.equal(cache.peek({ now: 200 }), null);
  assert.equal(cache.peek({ now: 200, allowStale: true }), processes);
});
