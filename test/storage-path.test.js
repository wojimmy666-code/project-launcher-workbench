const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  isPathStoredOnVolumeSync,
  resolveStoragePathSync
} = require("../server/storage-path");

const logicalSessions = "C:\\Users\\HUAWEI\\.codex\\sessions";
const physicalSessions = "D:\\CodexData\\sessions";

function redirectedOptions() {
  return {
    pathApi: path.win32,
    platform: "win32",
    realpathSync: () => physicalSessions
  };
}

test("storage resolution follows a Windows Junction to its physical volume", () => {
  const result = resolveStoragePathSync(logicalSessions, redirectedOptions());

  assert.equal(result.logicalPath, logicalSessions);
  assert.equal(result.physicalPath, physicalSessions);
  assert.equal(result.logicalVolumeRoot, "C:\\");
  assert.equal(result.physicalVolumeRoot, "D:\\");
  assert.equal(result.exists, true);
  assert.equal(result.isRedirected, true);
  assert.equal(result.isDifferentVolume, true);
});

test("cleanup volume attribution uses the physical Junction target", () => {
  const options = redirectedOptions();

  assert.equal(isPathStoredOnVolumeSync(logicalSessions, "C:\\", options), false);
  assert.equal(isPathStoredOnVolumeSync(logicalSessions, "D:\\", options), true);
});

test("a direct path remains attributed to its own volume", () => {
  const options = {
    pathApi: path.win32,
    platform: "win32",
    realpathSync: (value) => value
  };
  const result = resolveStoragePathSync(physicalSessions, options);

  assert.equal(result.isRedirected, false);
  assert.equal(result.isDifferentVolume, false);
  assert.equal(isPathStoredOnVolumeSync(physicalSessions, "D:\\", options), true);
});

test("a missing path is reported without inventing a different volume", () => {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  const result = resolveStoragePathSync(logicalSessions, {
    pathApi: path.win32,
    platform: "win32",
    realpathSync: () => { throw error; }
  });

  assert.equal(result.exists, false);
  assert.equal(result.physicalPath, logicalSessions);
  assert.equal(result.isRedirected, false);
  assert.equal(result.isDifferentVolume, false);
});
