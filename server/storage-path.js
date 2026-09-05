const fs = require("node:fs");
const path = require("node:path");

function resolveStoragePathSync(inputPath, options = {}) {
  const pathApi = options.pathApi || path;
  const platform = options.platform || process.platform;
  const realpathSync = options.realpathSync || fs.realpathSync.native;
  const logicalPath = pathApi.resolve(String(inputPath || ""));
  let physicalPath = logicalPath;
  let exists = true;

  try {
    physicalPath = pathApi.resolve(realpathSync(logicalPath));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    exists = false;
  }

  const logicalVolumeRoot = pathApi.parse(logicalPath).root;
  const physicalVolumeRoot = pathApi.parse(physicalPath).root;
  const normalize = (value) => platform === "win32" ? value.toLowerCase() : value;

  return {
    logicalPath,
    physicalPath,
    logicalVolumeRoot,
    physicalVolumeRoot,
    exists,
    isRedirected: normalize(logicalPath) !== normalize(physicalPath),
    isDifferentVolume: normalize(logicalVolumeRoot) !== normalize(physicalVolumeRoot)
  };
}

function isPathStoredOnVolumeSync(inputPath, volumePath, options = {}) {
  const pathApi = options.pathApi || path;
  const platform = options.platform || process.platform;
  const storage = resolveStoragePathSync(inputPath, options);
  const volumeRoot = pathApi.parse(pathApi.resolve(String(volumePath || ""))).root;
  const normalize = (value) => platform === "win32" ? value.toLowerCase() : value;
  return normalize(storage.physicalVolumeRoot) === normalize(volumeRoot);
}

module.exports = {
  isPathStoredOnVolumeSync,
  resolveStoragePathSync
};
