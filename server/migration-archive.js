const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEMP_ROOT = path.join(os.tmpdir(), "project-launcher-workbench-migration");
const MANIFEST_FILE = "manifest.json";
const REPOSITORIES_DIRECTORY = "repositories";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

class MigrationArchiveError extends Error {
  constructor(message, details = null, statusCode = 400) {
    super(message);
    this.name = "MigrationArchiveError";
    this.details = details;
    this.statusCode = statusCode;
  }
}

function createMigrationArchive(migrationPackage, signPackage) {
  ensureTempRoot();
  const stagingDirectory = fs.mkdtempSync(path.join(TEMP_ROOT, "export-"));
  const repositoriesDirectory = path.join(stagingDirectory, REPOSITORIES_DIRECTORY);
  fs.mkdirSync(repositoriesDirectory, { recursive: true });

  try {
    const nextPackage = JSON.parse(JSON.stringify(migrationPackage));
    const sourceMappings = Object.fromEntries(
      Object.entries(nextPackage.pathVariables || {}).map(([name, definition]) => [name, definition?.sourceValue || ""])
    );

    nextPackage.repositories = (nextPackage.repositories || []).map((repository) => {
      if (repository.restoreMode !== "bundle") return repository;
      const sourceRoot = materializeVariables(repository.root || "", sourceMappings);
      if (!sourceRoot || !fs.existsSync(path.join(sourceRoot, ".git"))) {
        throw new MigrationArchiveError(`无法为仓库生成离线包：${sourceRoot || repository.root}`);
      }

      const relativeFile = `${REPOSITORIES_DIRECTORY}/${repository.id}.bundle`;
      const bundlePath = path.join(stagingDirectory, ...relativeFile.split("/"));
      runRequired("git", ["bundle", "create", bundlePath, "--all"], {
        cwd: sourceRoot,
        timeout: 5 * 60 * 1000,
        message: `Git Bundle 生成失败：${sourceRoot}`
      });
      return {
        ...repository,
        bundle: {
          file: relativeFile,
          size: fs.statSync(bundlePath).size,
          sha256: hashFile(bundlePath)
        }
      };
    });

    const signedPackage = signPackage(nextPackage);
    fs.writeFileSync(path.join(stagingDirectory, MANIFEST_FILE), `${JSON.stringify(signedPackage, null, 2)}\n`, "utf8");
    const archivePath = path.join(stagingDirectory, "migration.plwmigrate");
    runRequired("tar", ["-czf", archivePath, "-C", stagingDirectory, MANIFEST_FILE, REPOSITORIES_DIRECTORY], {
      timeout: 5 * 60 * 1000,
      message: "迁移包归档失败"
    });
    return {
      archivePath,
      migrationPackage: signedPackage,
      size: fs.statSync(archivePath).size,
      cleanup: () => removeTempDirectory(stagingDirectory)
    };
  } catch (error) {
    removeTempDirectory(stagingDirectory);
    throw error;
  }
}

function extractMigrationArchive(archivePath, verifyPackage) {
  ensureTempRoot();
  const extractionDirectory = fs.mkdtempSync(path.join(TEMP_ROOT, "import-"));
  try {
    const listing = runRequired("tar", ["-tzf", archivePath], {
      timeout: 2 * 60 * 1000,
      message: "无法读取迁移包目录"
    });
    const entries = String(listing || "").split(/\r?\n/).filter(Boolean).map(validateArchiveEntry);
    if (!entries.includes(MANIFEST_FILE)) {
      throw new MigrationArchiveError("迁移包缺少 manifest.json");
    }
    const verboseListing = runRequired("tar", ["-tvzf", archivePath], {
      timeout: 2 * 60 * 1000,
      message: "无法检查迁移包文件类型"
    });
    for (const line of String(verboseListing || "").split(/\r?\n/).filter(Boolean)) {
      if (!line.startsWith("-") && !line.startsWith("d")) {
        throw new MigrationArchiveError("迁移包包含链接或其他不安全文件类型");
      }
    }

    runRequired("tar", ["-xzf", archivePath, "-C", extractionDirectory], {
      timeout: 5 * 60 * 1000,
      message: "迁移包解压失败"
    });
    assertSafeExtractedTree(extractionDirectory);

    const manifestPath = path.join(extractionDirectory, MANIFEST_FILE);
    const manifestStat = fs.statSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new MigrationArchiveError("迁移清单无效或过大");
    }
    const migrationPackage = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
    verifyPackage(migrationPackage);
    verifyRepositoryBundles(migrationPackage, extractionDirectory, entries);

    return {
      extractionDirectory,
      migrationPackage,
      cleanup: () => removeTempDirectory(extractionDirectory)
    };
  } catch (error) {
    removeTempDirectory(extractionDirectory);
    if (error instanceof SyntaxError) throw new MigrationArchiveError("迁移清单不是有效 JSON");
    throw error;
  }
}

function restoreMigrationRepositories(migrationPackage, mappings, extractionDirectory) {
  const repositories = migrationPackage.repositories || [];
  const createdRoots = [];
  const restored = [];
  try {
    for (const repository of repositories) {
      const materializedRoot = materializeVariables(repository.root || "", mappings);
      if (!materializedRoot || !path.isAbsolute(materializedRoot) || /\$\{[A-Z][A-Z0-9_]*\}/.test(materializedRoot)) {
        throw new MigrationArchiveError(`仓库目标路径无效：${repository.root}`);
      }
      const targetRoot = path.resolve(materializedRoot);
      const mappedRoots = Object.values(mappings || {}).filter(Boolean).map((value) => path.resolve(value));
      if (repository.restoreMode !== "manual" && !mappedRoots.some((mappedRoot) => isPathInside(targetRoot, mappedRoot))) {
        throw new MigrationArchiveError(`仓库目标路径位于项目根目录之外：${targetRoot}`, null, 409);
      }

      if (repository.restoreMode === "manual") {
        if (!fs.existsSync(targetRoot)) {
          throw new MigrationArchiveError(`仓库需要手动准备：${targetRoot}`, null, 409);
        }
        restored.push({ repositoryId: repository.id, root: targetRoot, created: false, manual: true });
        continue;
      }
      if (fs.existsSync(targetRoot)) {
        validateExistingRepository(repository, targetRoot);
        restored.push({ repositoryId: repository.id, root: targetRoot, created: false });
        continue;
      }
      fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
      const temporaryTarget = `${targetRoot}.migration-${crypto.randomUUID()}`;
      try {
        const source = repository.restoreMode === "bundle"
          ? resolveBundlePath(repository, extractionDirectory)
          : repository.remote;
        if (!source) throw new MigrationArchiveError(`仓库缺少可用恢复来源：${targetRoot}`);

        const cloneArgs = ["clone"];
        if (repository.commit) cloneArgs.push("--no-checkout");
        cloneArgs.push("--", source, temporaryTarget);
        runRequired("git", cloneArgs, {
          timeout: 15 * 60 * 1000,
          message: `仓库恢复失败：${targetRoot}`
        });
        checkoutRepositoryRevision(temporaryTarget, repository);
        fs.renameSync(temporaryTarget, targetRoot);
        createdRoots.push(targetRoot);
        restored.push({ repositoryId: repository.id, root: targetRoot, created: true });
      } catch (error) {
        removePath(temporaryTarget);
        throw error;
      }
    }

    const warnings = validateProjectBindings(migrationPackage.projectRepositoryBindings || [], restored);
    return { restored, createdRoots, warnings };
  } catch (error) {
    for (const createdRoot of createdRoots.reverse()) removePath(createdRoot);
    throw error;
  }
}

function validateArchiveEntry(entry) {
  const normalized = String(entry || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[a-z]:/i.test(normalized)
    || segments.includes("..")
    || segments.includes("")
  ) {
    throw new MigrationArchiveError(`迁移包包含不安全路径：${entry}`);
  }
  const allowed = normalized === MANIFEST_FILE
    || normalized === REPOSITORIES_DIRECTORY
    || /^repositories\/[a-zA-Z0-9_-]+\.bundle$/.test(normalized);
  if (!allowed) throw new MigrationArchiveError(`迁移包包含未知文件：${entry}`);
  return normalized;
}

function verifyRepositoryBundles(migrationPackage, extractionDirectory, entries) {
  const expectedBundleFiles = new Set();
  for (const repository of migrationPackage.repositories || []) {
    if (repository.restoreMode !== "bundle") continue;
    const bundle = repository.bundle;
    if (!bundle?.file || !bundle?.sha256 || !Number.isSafeInteger(bundle?.size)) {
      throw new MigrationArchiveError(`仓库 ${repository.id} 缺少离线 Bundle 元数据`);
    }
    const normalizedFile = validateArchiveEntry(bundle.file);
    const expectedFile = `${REPOSITORIES_DIRECTORY}/${repository.id}.bundle`;
    if (normalizedFile !== expectedFile) throw new MigrationArchiveError(`仓库 ${repository.id} 的 Bundle 路径无效`);
    expectedBundleFiles.add(normalizedFile);
    const bundlePath = path.join(extractionDirectory, ...normalizedFile.split("/"));
    if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isFile()) {
      throw new MigrationArchiveError(`仓库 ${repository.id} 的离线 Bundle 缺失`);
    }
    if (fs.statSync(bundlePath).size !== bundle.size || hashFile(bundlePath) !== String(bundle.sha256).toLowerCase()) {
      throw new MigrationArchiveError(`仓库 ${repository.id} 的离线 Bundle 完整性校验失败`);
    }
    runRequired("git", ["bundle", "list-heads", bundlePath], {
      timeout: 2 * 60 * 1000,
      message: `仓库 ${repository.id} 的离线 Bundle 无效`
    });
  }

  for (const entry of entries) {
    if (entry.endsWith(".bundle") && !expectedBundleFiles.has(entry)) {
      throw new MigrationArchiveError(`迁移包包含未登记的 Bundle：${entry}`);
    }
  }
}

function validateExistingRepository(repository, targetRoot) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    throw new MigrationArchiveError(`目标目录已存在但不是对应 Git 仓库：${targetRoot}`, null, 409);
  }
  if (repository.commit) {
    runRequired("git", ["cat-file", "-e", `${repository.commit}^{commit}`], {
      cwd: targetRoot,
      message: `目标仓库缺少迁移所需提交：${targetRoot}`,
      statusCode: 409
    });
  }
  if (repository.remote) {
    const actualRemote = runOptional("git", ["remote", "get-url", "origin"], { cwd: targetRoot });
    if (actualRemote && normalizeRemote(actualRemote) !== normalizeRemote(repository.remote)) {
      throw new MigrationArchiveError(`目标仓库 origin 与迁移包不一致：${targetRoot}`, null, 409);
    }
  }
}

function checkoutRepositoryRevision(repositoryRoot, repository) {
  if (!repository.commit) return;
  const args = repository.branch
    ? ["checkout", "-B", repository.branch, repository.commit]
    : ["checkout", "--detach", repository.commit];
  runRequired("git", args, {
    cwd: repositoryRoot,
    timeout: 2 * 60 * 1000,
    message: `无法切换仓库版本：${repositoryRoot}`
  });
}

function validateProjectBindings(bindings, restoredRepositories) {
  const restoredById = new Map(restoredRepositories.map((entry) => [entry.repositoryId, entry.root]));
  const warnings = [];
  for (const projectBinding of bindings || []) {
    for (const binding of projectBinding.repositoryBindings || []) {
      const repositoryRoot = restoredById.get(binding.repositoryId);
      if (!repositoryRoot) throw new MigrationArchiveError(`项目 ${projectBinding.projectId} 引用了未知仓库`);
      for (const [field, relativePath] of Object.entries(binding.relativePaths || {})) {
        const normalized = String(relativePath || ".").replace(/\\/g, "/");
        if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
          throw new MigrationArchiveError(`项目 ${projectBinding.projectId} 的仓库相对路径无效`);
        }
        const target = path.resolve(repositoryRoot, ...normalized.split("/"));
        if (!isPathInside(target, repositoryRoot)) {
          throw new MigrationArchiveError(`项目 ${projectBinding.projectId} 的仓库路径越界`);
        }
        if (!fs.existsSync(target)) {
          warnings.push({
            code: "bound_path_missing",
            message: `项目 ${projectBinding.projectId} 的 ${field} 在恢复后的仓库中不存在：${target}`
          });
        }
      }
    }
  }
  return warnings;
}

function resolveBundlePath(repository, extractionDirectory) {
  const normalized = validateArchiveEntry(repository.bundle?.file || "");
  const bundlePath = path.resolve(extractionDirectory, ...normalized.split("/"));
  if (!isPathInside(bundlePath, extractionDirectory)) throw new MigrationArchiveError("Bundle 路径越界");
  return bundlePath;
}

function assertSafeExtractedTree(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const name of fs.readdirSync(current)) {
      const item = path.join(current, name);
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) throw new MigrationArchiveError("迁移包不能包含符号链接");
      if (stat.isDirectory()) pending.push(item);
      else if (!stat.isFile()) throw new MigrationArchiveError("迁移包包含不支持的文件类型");
    }
  }
}

function createUploadPath() {
  ensureTempRoot();
  return path.join(TEMP_ROOT, `upload-${crypto.randomUUID()}.plwmigrate`);
}

function signPackageCore(migrationPackage, checksumPackageCore) {
  const core = JSON.parse(JSON.stringify(migrationPackage));
  delete core.integrity;
  return {
    ...core,
    integrity: { algorithm: "sha256", checksum: checksumPackageCore(core) }
  };
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function materializeVariables(value, mappings) {
  return String(value || "").replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(mappings || {}, name) ? mappings[name] : match
  ));
}

function normalizeRemote(value) {
  return String(value || "").trim().replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function isPathInside(value, root) {
  const target = path.resolve(value).toLowerCase();
  const base = path.resolve(root).replace(/[\\/]+$/, "").toLowerCase();
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function runRequired(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0 || result.error) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    throw new MigrationArchiveError(options.message || `${command} 执行失败`, detail || null, options.statusCode || 400);
  }
  return String(result.stdout || "").trim();
}

function runOptional(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 30_000
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function ensureTempRoot() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
}

function removeTempDirectory(directory) {
  if (!directory || !isPathInside(directory, TEMP_ROOT) || path.resolve(directory) === path.resolve(TEMP_ROOT)) return;
  fs.rmSync(directory, { recursive: true, force: true });
}

function removePath(target) {
  if (!target || !fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = {
  MigrationArchiveError,
  TEMP_ROOT,
  createMigrationArchive,
  createUploadPath,
  extractMigrationArchive,
  removeTempDirectory,
  restoreMigrationRepositories,
  signPackageCore,
  validateArchiveEntry
};
