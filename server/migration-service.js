const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageJson = require("../package.json");
const { CONFIG_PATH, ROOT_DIR } = require("./config");
const { replaceConfigSnapshot } = require("./config-manager");
const { resolveProjectPort, resolveProjectPorts } = require("./project-port");
const {
  createMigrationArchive,
  extractMigrationArchive,
  restoreMigrationRepositories,
  signPackageCore
} = require("./migration-archive");

const MIGRATION_FORMAT = "project-launcher-workbench-migration";
const MIGRATION_SCHEMA_VERSION = 2;
const PATH_VARIABLE_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const PROJECT_STRING_PATH_FIELDS = ["path", "cwd", "codexCwd", "command"];
const PROJECT_ARRAY_PATH_FIELDS = ["args", "processMatch"];
const ALLOWED_PROJECT_TYPES = new Set(["exe", "bat", "cmd", "url", "folder", "file"]);
const IMPORT_SESSION_TTL_MS = 30 * 60 * 1000;

class MigrationError extends Error {
  constructor(message, details = null, statusCode = 400) {
    super(message);
    this.name = "MigrationError";
    this.details = details;
    this.statusCode = statusCode;
  }
}

function createMigrationService(options = {}) {
  const configPath = options.configPath || CONFIG_PATH;
  const rootDir = options.rootDir || ROOT_DIR;
  const projectsRoot = path.resolve(options.projectsRoot || path.dirname(rootDir));
  const fsApi = options.fs || fs;
  const now = options.now || (() => new Date());
  const readConfig = options.readConfig || (() => readJsonFile(configPath, fsApi));
  const writeConfig = options.writeConfig || ((config) => replaceConfigSnapshot(config));
  const repositoryInspector = options.inspectRepositories || ((config, roots) => (
    inspectRepositories(config, roots, { fs: fsApi, runGit: options.runGit })
  ));
  const dependencyInspector = options.inspectDependencies || (() => inspectDependencies({
    runGit: options.runGit,
    runCommand: options.runCommand
  }));
  const importSessions = new Map();

  function inspectExport() {
    const config = readConfig();
    const roots = normalizeWorkspaceRoots({ PROJECTS_ROOT: projectsRoot });
    const portableConfig = transformConfigPaths(config, (value) => portableizePathValue(value, roots));
    const repositories = prepareRepositories(repositoryInspector(config, roots));
    const projectRepositoryBindings = buildProjectRepositoryBindings(config, repositories, roots);
    const pathInspection = inspectConfiguredPaths(config, roots, fsApi);
    const blockers = [
      ...repositoryBlockers(repositories),
      ...sensitiveConfigBlockers(config)
    ];
    const warnings = [
      ...repositoryWarnings(repositories),
      ...pathInspection.warnings
    ];

    const inspectionChecksum = createExportInspectionChecksum(portableConfig, repositories);

    return {
      canExport: blockers.length === 0,
      inspectionChecksum,
      roots,
      portableConfig,
      repositories,
      projectRepositoryBindings,
      dependencies: dependencyInspector(),
      blockers,
      warnings,
      summary: {
        projectCount: Array.isArray(config.projects) ? config.projects.length : 0,
        categoryCount: Array.isArray(config.categories) ? config.categories.length : 0,
        repositoryCount: repositories.length,
        remoteRepositoryCount: repositories.filter((entry) => entry.restoreMode === "remote").length,
        bundledRepositoryCount: repositories.filter((entry) => entry.restoreMode === "bundle").length,
        manualRepositoryCount: repositories.filter((entry) => entry.restoreMode === "manual").length,
        portablePathCount: pathInspection.portablePathCount,
        externalPathCount: pathInspection.externalPaths.length,
        missingPathCount: pathInspection.missingPaths.length
      }
    };
  }

  function exportPackage(options = {}) {
    const preview = inspectExport();
    const expectedInspectionChecksum = String(options.inspectionChecksum || options.expectedInspectionChecksum || "").trim();
    if (expectedInspectionChecksum && expectedInspectionChecksum !== preview.inspectionChecksum) {
      throw new MigrationError("仓库或项目配置在扫描后发生了变化，请重新扫描再导出", [{
        code: "stale_export_inspection",
        message: "导出预检已过期，未生成迁移包"
      }], 409);
    }
    if (!preview.canExport) {
      throw new MigrationError("导出前检查未通过，请先处理未提交文件或疑似敏感配置", preview.blockers, 409);
    }

    const repositories = applyRepositorySelections(preview.repositories, options.repositorySelections);
    const warnings = dedupeIssues([
      ...preview.warnings.filter((entry) => !["offline_bundle", "manual_restore"].includes(entry.code)),
      ...repositoryWarnings(repositories)
    ]);
    const selectedPreview = {
      ...preview,
      repositories,
      warnings,
      summary: summarizeRepositories(preview.summary, repositories)
    };

    const createdAt = now().toISOString();
    const migrationPackage = createMigrationPackage({
      createdAt,
      config: preview.portableConfig,
      roots: preview.roots,
      repositories,
      projectRepositoryBindings: preview.projectRepositoryBindings,
      dependencies: preview.dependencies,
      warnings
    });

    return {
      fileName: `project-workbench-${fileTimestamp(createdAt)}.plwmigrate`,
      package: migrationPackage,
      preview: publicExportPreview(selectedPreview)
    };
  }

  function exportArchive(options = {}) {
    const exported = exportPackage(options);
    const artifact = createMigrationArchive(exported.package, signMigrationPackage);
    return {
      ...artifact,
      fileName: exported.fileName,
      preview: exported.preview
    };
  }

  function inspectImport(migrationPackage, rootMappings = {}, archiveContext = {}) {
    verifyMigrationPackage(migrationPackage);
    const mappings = resolveImportMappings(migrationPackage, rootMappings, {
      PROJECTS_ROOT: projectsRoot
    });
    const resolvedConfig = transformConfigPaths(
      migrationPackage.config,
      (value) => materializePathValue(value, mappings)
    );
    const blockers = validateImportedConfig(resolvedConfig);
    const unresolvedVariables = collectUnresolvedVariables(resolvedConfig);
    for (const variable of unresolvedVariables) {
      blockers.push(issue("unresolved_path_variable", `路径变量 \${${variable}} 尚未映射`));
    }

    const repositoryResults = inspectImportRepositories(migrationPackage.repositories, mappings, {
      fs: fsApi,
      runGit: options.runGit,
      extractionDirectory: archiveContext.extractionDirectory
    });
    blockers.push(...repositoryResults.flatMap((entry) => entry.blockers || []));
    const pathInspection = inspectConfiguredPaths(resolvedConfig, {}, fsApi);
    const warnings = [
      ...repositoryResults.flatMap((entry) => entry.warnings || []),
      ...pathInspection.warnings
    ];

    return {
      valid: blockers.length === 0,
      canApply: blockers.length === 0,
      checksum: migrationPackage.integrity.checksum,
      packageInfo: {
        format: migrationPackage.format,
        schemaVersion: migrationPackage.schemaVersion,
        createdAt: migrationPackage.createdAt,
        source: migrationPackage.source || {},
        projectCount: Array.isArray(resolvedConfig.projects) ? resolvedConfig.projects.length : 0,
        repositoryCount: repositoryResults.length
      },
      mappings,
      repositories: repositoryResults,
      blockers: dedupeIssues(blockers),
      warnings: dedupeIssues(warnings),
      resolvedConfig
    };
  }

  function inspectImportArchive(archivePath, rootMappings = {}) {
    sweepImportSessions();
    const extracted = extractMigrationArchive(archivePath, verifyMigrationPackage);
    try {
      const inspection = inspectImport(extracted.migrationPackage, rootMappings, {
        extractionDirectory: extracted.extractionDirectory
      });
      const importToken = crypto.randomUUID();
      const session = {
        ...extracted,
        expiresAt: Date.now() + IMPORT_SESSION_TTL_MS
      };
      session.expirationTimer = setTimeout(() => disposeImportSession(importToken), IMPORT_SESSION_TTL_MS);
      session.expirationTimer.unref?.();
      importSessions.set(importToken, session);
      return { ...inspection, importToken };
    } catch (error) {
      extracted.cleanup();
      throw error;
    }
  }

  function applyImportArchive(importToken, rootMappings = {}, expectedChecksum = "") {
    sweepImportSessions();
    const session = importSessions.get(String(importToken || ""));
    if (!session) throw new MigrationError("迁移包预检已失效，请重新选择文件并预检", null, 410);

    const inspection = inspectImport(session.migrationPackage, rootMappings, {
      extractionDirectory: session.extractionDirectory
    });
    if (expectedChecksum && expectedChecksum !== inspection.checksum) {
      throw new MigrationError("迁移包在预检后发生变化，请重新选择并检查迁移包");
    }
    if (!inspection.canApply) {
      throw new MigrationError("迁移包不能应用，请先处理阻止项", inspection.blockers, 409);
    }

    const restoration = restoreMigrationRepositories(
      session.migrationPackage,
      inspection.mappings,
      session.extractionDirectory
    );
    try {
      const result = writeConfig(inspection.resolvedConfig);
      disposeImportSession(importToken);
      return {
        ok: true,
        checksum: inspection.checksum,
        projectCount: inspection.packageInfo.projectCount,
        repositoryCount: inspection.packageInfo.repositoryCount,
        restoredRepositoryCount: restoration.restored.length,
        createdRepositoryCount: restoration.createdRoots.length,
        mappings: inspection.mappings,
        warnings: dedupeIssues([...inspection.warnings, ...restoration.warnings]),
        backupFile: result?.backupFile || null
      };
    } catch (error) {
      for (const createdRoot of restoration.createdRoots.reverse()) {
        try {
          fsApi.rmSync(createdRoot, { recursive: true, force: true });
        } catch {
          // The config write error is more useful than a cleanup error.
        }
      }
      throw error;
    }
  }

  function sweepImportSessions() {
    const currentTime = Date.now();
    for (const [token, session] of importSessions) {
      if (session.expiresAt > currentTime) continue;
      disposeImportSession(token);
    }
  }

  function disposeImportSession(token) {
    const session = importSessions.get(token);
    if (!session) return;
    clearTimeout(session.expirationTimer);
    session.cleanup();
    importSessions.delete(token);
  }

  function applyImport(migrationPackage, rootMappings = {}, expectedChecksum = "") {
    const inspection = inspectImport(migrationPackage, rootMappings);
    if (expectedChecksum && expectedChecksum !== inspection.checksum) {
      throw new MigrationError("迁移包在预检后发生变化，请重新选择并检查迁移包");
    }
    if (!inspection.canApply) {
      throw new MigrationError("迁移包不能应用，请先处理阻止项", inspection.blockers, 409);
    }

    const result = writeConfig(inspection.resolvedConfig);
    return {
      ok: true,
      checksum: inspection.checksum,
      projectCount: inspection.packageInfo.projectCount,
      repositoryCount: inspection.packageInfo.repositoryCount,
      mappings: inspection.mappings,
      warnings: inspection.warnings,
      backupFile: result?.backupFile || null
    };
  }

  return {
    applyImport,
    applyImportArchive,
    exportArchive,
    exportPackage,
    inspectExport,
    inspectImport,
    inspectImportArchive
  };
}

function createMigrationPackage({
  createdAt,
  config,
  roots,
  repositories,
  projectRepositoryBindings = [],
  dependencies,
  warnings = []
}) {
  const core = {
    format: MIGRATION_FORMAT,
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    createdAt,
    source: {
      platform: process.platform,
      arch: process.arch,
      workbenchVersion: packageJson.version,
      nodeVersion: process.version
    },
    pathVariables: Object.fromEntries(
      Object.entries(roots).map(([name, value]) => [name, {
        sourceValue: value,
        description: name === "PROJECTS_ROOT" ? "项目仓库根目录" : name
      }])
    ),
    config: deepClone(config),
    repositories: deepClone(repositories),
    projectRepositoryBindings: deepClone(projectRepositoryBindings),
    dependencies: deepClone(dependencies),
    exclusions: [
      "项目源码与 Git 对象",
      "node_modules 与 Python 虚拟环境",
      "运行时 PID、日志与缓存",
      "API 密钥、登录凭据与 SSH 私钥",
      "Codex 会话与个人数据"
    ],
    warnings: deepClone(warnings)
  };
  return signMigrationPackage(core);
}

function signMigrationPackage(migrationPackage) {
  return signPackageCore(migrationPackage, checksumPackageCore);
}

function verifyMigrationPackage(migrationPackage) {
  if (!migrationPackage || typeof migrationPackage !== "object" || Array.isArray(migrationPackage)) {
    throw new MigrationError("迁移包格式无效");
  }
  if (migrationPackage.format !== MIGRATION_FORMAT) {
    throw new MigrationError("这不是项目管理台迁移包");
  }
  if (Number(migrationPackage.schemaVersion) !== MIGRATION_SCHEMA_VERSION) {
    throw new MigrationError(`不支持的迁移包版本：${migrationPackage.schemaVersion}`);
  }
  if (!migrationPackage.config || !Array.isArray(migrationPackage.config.projects)) {
    throw new MigrationError("迁移包缺少项目配置");
  }
  if (!Array.isArray(migrationPackage.repositories) || !Array.isArray(migrationPackage.projectRepositoryBindings)) {
    throw new MigrationError("迁移包缺少仓库清单或项目绑定");
  }
  validateMigrationRepositoryManifest(migrationPackage);
  if (migrationPackage.integrity?.algorithm !== "sha256" || !migrationPackage.integrity?.checksum) {
    throw new MigrationError("迁移包缺少完整性校验信息");
  }

  const core = deepClone(migrationPackage);
  delete core.integrity;
  const actual = checksumPackageCore(core);
  const expected = String(migrationPackage.integrity.checksum).toLowerCase();
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = /^[a-f0-9]{64}$/i.test(expected) ? Buffer.from(expected, "hex") : Buffer.alloc(0);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new MigrationError("迁移包完整性校验失败，文件可能已损坏或被修改");
  }
  return true;
}

function transformConfigPaths(config, transform) {
  const result = deepClone(config);
  result.projects = (Array.isArray(result.projects) ? result.projects : []).map((project) => {
    const next = { ...project };
    for (const field of PROJECT_STRING_PATH_FIELDS) {
      if (typeof next[field] === "string") next[field] = transform(next[field]);
    }
    for (const field of PROJECT_ARRAY_PATH_FIELDS) {
      if (Array.isArray(next[field])) {
        next[field] = next[field].map((value) => typeof value === "string" ? transform(value) : value);
      }
    }
    return next;
  });
  return result;
}

function normalizeWorkspaceRoots(roots) {
  return Object.fromEntries(
    Object.entries(roots || {})
      .filter(([name, value]) => /^[A-Z][A-Z0-9_]*$/.test(name) && value)
      .map(([name, value]) => [name, trimTrailingSeparator(path.resolve(String(value)))])
      .sort((a, b) => b[1].length - a[1].length)
  );
}

function portableizePathValue(value, roots) {
  let result = String(value || "");
  for (const [name, root] of Object.entries(roots)) {
    result = replacePathPrefixOccurrences(result, root, `\${${name}}`);
  }
  return result;
}

function materializePathValue(value, mappings) {
  return String(value || "").replace(PATH_VARIABLE_PATTERN, (match, name) => (
    Object.prototype.hasOwnProperty.call(mappings, name) ? mappings[name] : match
  ));
}

function replacePathPrefixOccurrences(value, root, replacement) {
  const normalizedRoot = trimTrailingSeparator(String(root || ""));
  if (!normalizedRoot) return value;
  const escaped = escapeRegExp(normalizedRoot).replace(/[\\/]+/g, "[\\\\/]+");
  const matcher = new RegExp(`${escaped}(?=$|[\\\\/])`, "gi");
  return value.replace(matcher, replacement);
}

function resolveImportMappings(migrationPackage, provided, defaults = {}) {
  const definitions = migrationPackage.pathVariables || {};
  const mappings = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const raw = provided?.[name] || defaults[name] || definition?.sourceValue;
    if (!raw) {
      throw new MigrationError(`缺少路径变量映射：${name}`);
    }
    const value = trimTrailingSeparator(String(raw).trim());
    if (!isAbsolutePath(value) || PATH_VARIABLE_PATTERN.test(value)) {
      PATH_VARIABLE_PATTERN.lastIndex = 0;
      throw new MigrationError(`${name} 必须映射到绝对路径`);
    }
    PATH_VARIABLE_PATTERN.lastIndex = 0;
    mappings[name] = path.resolve(value);
  }
  return mappings;
}

function validateImportedConfig(config) {
  const blockers = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [issue("invalid_config", "项目配置必须是对象")];
  }
  if (!Array.isArray(config.projects)) blockers.push(issue("invalid_projects", "项目列表格式无效"));
  if (!Array.isArray(config.categories)) blockers.push(issue("invalid_categories", "分类列表格式无效"));
  if (blockers.length) return blockers;

  const categoryIds = new Set(["uncategorized"]);
  for (const category of config.categories) {
    const id = String(category?.id || "").trim();
    if (!id || categoryIds.has(id)) {
      blockers.push(issue("duplicate_category", `分类 ID 无效或重复：${id || "（空）"}`));
    } else {
      categoryIds.add(id);
    }
  }

  const projectIds = new Set();
  const occupiedPorts = new Map();
  for (const project of config.projects) {
    const id = String(project?.id || "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || projectIds.has(id)) {
      blockers.push(issue("duplicate_project", `项目 ID 无效或重复：${id || "（空）"}`));
      continue;
    }
    projectIds.add(id);
    if (!String(project.name || "").trim()) blockers.push(issue("missing_project_name", `项目 ${id} 缺少名称`));
    const projectType = String(project.type || "").trim().toLowerCase();
    if (!ALLOWED_PROJECT_TYPES.has(projectType)) {
      blockers.push(issue("invalid_project_type", `项目 ${id} 的类型无效`));
    }
    if (["exe", "bat", "folder", "file"].includes(projectType) && !String(project.path || "").trim()) {
      blockers.push(issue("missing_launch_path", `项目 ${id} 缺少路径`));
    }
    if (projectType === "cmd" && !String(project.command || "").trim()) {
      blockers.push(issue("missing_launch_command", `项目 ${id} 缺少启动命令`));
    }
    if (projectType === "url" && !String(project.url || "").trim()) {
      blockers.push(issue("missing_project_url", `项目 ${id} 缺少网址`));
    }
    if (project.category && !categoryIds.has(String(project.category))) {
      blockers.push(issue("invalid_project_category", `项目 ${id} 引用了不存在的分类 ${project.category}`));
    }

    const rawPorts = [project.port, ...(Array.isArray(project.auxiliaryPorts) ? project.auxiliaryPorts : [])]
      .map(Number)
      .filter(Number.isInteger);
    for (const port of rawPorts) {
      if (port < 1 || port > 65535) {
        blockers.push(issue("invalid_port", `项目 ${id} 的端口 ${port} 无效`));
      }
    }
    const primaryPort = resolveProjectPort(project);
    const auxiliaryPorts = (Array.isArray(project.auxiliaryPorts) ? project.auxiliaryPorts : []).map(Number);
    if (Number.isInteger(primaryPort) && auxiliaryPorts.includes(primaryPort)) {
      blockers.push(issue("duplicate_auxiliary_port", `项目 ${id} 的辅助端口不能与主端口 ${primaryPort} 相同`));
    }
    for (const port of resolveProjectPorts(project)) {
      const owner = occupiedPorts.get(port);
      if (owner && owner !== id) {
        blockers.push(issue("duplicate_port", `项目 ${id} 与 ${owner} 重复使用端口 ${port}`));
      } else {
        occupiedPorts.set(port, id);
      }
    }
  }
  return dedupeIssues(blockers);
}

function collectUnresolvedVariables(config) {
  const found = new Set();
  walkStrings(config, (value) => {
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) found.add(match[1]);
  });
  return [...found];
}

function inspectRepositories(config, roots, options = {}) {
  const fsApi = options.fs || fs;
  const byRoot = new Map();
  for (const project of config.projects || []) {
    const candidateDirectories = projectCandidateDirectories(project, fsApi);
    let repositoryRoot = null;
    for (const directory of candidateDirectories) {
      repositoryRoot = findGitRoot(directory, fsApi);
      if (repositoryRoot) break;
    }

    if (repositoryRoot) {
      const key = path.resolve(repositoryRoot).toLowerCase();
      if (!byRoot.has(key)) {
        byRoot.set(key, inspectGitRepository(repositoryRoot, roots, options.runGit));
      }
      const repository = byRoot.get(key);
      if (!repository.remote && project.githubUrl) {
        repository.remote = project.githubUrl;
        repository.remoteSource = "configured";
      }
      repository.projectIds.push(project.id);
      continue;
    }

    const destination = candidateDirectories[0] || inferProjectDirectory(project);
    if (destination || project.githubUrl) {
      const key = `planned:${String(destination || project.githubUrl).toLowerCase()}`;
      if (!byRoot.has(key)) {
        byRoot.set(key, {
          root: portableizePathValue(destination || "", roots),
          remote: project.githubUrl || null,
          branch: null,
          commit: null,
          upstream: null,
          clean: null,
          ahead: null,
          behind: null,
          remoteSource: project.githubUrl ? "configured" : null,
          state: "not_detected",
          projectIds: []
        });
      }
      byRoot.get(key).projectIds.push(project.id);
    }
  }

  return [...byRoot.values()].map((entry) => ({
    ...entry,
    projectIds: [...new Set(entry.projectIds)].sort()
  })).sort((a, b) => String(a.root).localeCompare(String(b.root), "zh-CN"));
}

function inspectGitRepository(repositoryRoot, roots, runGitOverride) {
  const runGit = runGitOverride || runGitCommand;
  const remote = runGit(repositoryRoot, ["remote", "get-url", "origin"]);
  const status = parseGitStatusV2(runGit(repositoryRoot, ["status", "--porcelain=v2", "--branch"]));
  const remoteCommit = status.upstream
    ? runGit(repositoryRoot, ["rev-parse", "@{upstream}"])
    : "";
  return {
    root: portableizePathValue(repositoryRoot, roots),
    remote: remote || null,
    remoteSource: remote ? "origin" : null,
    branch: status.branch,
    commit: status.commit,
    upstream: status.upstream,
    remoteCommit: remoteCommit || null,
    clean: status.clean,
    ahead: status.ahead,
    behind: status.behind,
    state: "git",
    projectIds: []
  };
}

function prepareRepositories(repositories) {
  return (repositories || []).map((repository) => {
    const rootKey = String(repository.root || repository.remote || repository.projectIds?.join(",") || "repository")
      .replace(/[\\/]+/g, "/")
      .toLowerCase();
    const remoteCommit = repository.remoteCommit
      || (repository.remote && repository.upstream && Number(repository.ahead || 0) === 0 ? repository.commit : null);
    const bundleEligible = repository.state === "git" && Boolean(repository.commit);
    const canRestoreRemote = repository.state === "git"
      ? Boolean(repository.remote && repository.upstream && remoteCommit)
      : Boolean(repository.remote);
    const defaultIncludeBundle = bundleEligible && (
      !canRestoreRemote || Number(repository.ahead || 0) > 0
    );
    const restoreMode = defaultIncludeBundle ? "bundle" : (canRestoreRemote ? "remote" : "manual");
    let bundleReason = null;
    if (bundleEligible) {
      if (!repository.remote) bundleReason = "no_remote";
      else if (!repository.upstream || !remoteCommit) bundleReason = "no_upstream";
      else if (Number(repository.ahead || 0) > 0) bundleReason = "unpushed_commits";
      else bundleReason = "offline_copy";
    }
    return {
      ...repository,
      id: repository.id || `repo-${crypto.createHash("sha256").update(rootKey).digest("hex").slice(0, 12)}`,
      remoteCommit,
      bundleEligible,
      bundleReason,
      defaultIncludeBundle,
      recommendedRestoreMode: restoreMode,
      restoreMode
    };
  });
}

function applyRepositorySelections(repositories, rawSelections = []) {
  const selections = Array.isArray(rawSelections) ? rawSelections : [];
  const repositoriesById = new Map((repositories || []).map((repository) => [repository.id, repository]));
  const selectionById = new Map();
  for (const selection of selections) {
    const repositoryId = String(selection?.repositoryId || "").trim();
    if (!repositoriesById.has(repositoryId)) {
      throw new MigrationError(`迁移选择包含未知仓库：${repositoryId || "（空）"}`, null, 409);
    }
    if (typeof selection.includeBundle !== "boolean") {
      throw new MigrationError(`仓库 ${repositoryId} 的离线包选择无效`);
    }
    selectionById.set(repositoryId, selection.includeBundle);
  }

  return (repositories || []).map((repository) => {
    const includeBundle = repository.bundleEligible
      ? (selectionById.has(repository.id) ? selectionById.get(repository.id) : repository.defaultIncludeBundle)
      : false;
    if (includeBundle) {
      return {
        ...repository,
        includeBundle: true,
        restoreMode: "bundle",
        omittedLocalCommitCount: 0
      };
    }

    const canRestoreRemote = repository.state === "git"
      ? Boolean(repository.remote && repository.upstream && repository.remoteCommit)
      : Boolean(repository.remote);
    if (canRestoreRemote) {
      return {
        ...repository,
        includeBundle: false,
        restoreMode: "remote",
        commit: repository.state === "git" ? repository.remoteCommit : repository.commit,
        omittedLocalCommitCount: repository.state === "git" ? Math.max(0, Number(repository.ahead || 0)) : 0
      };
    }
    return {
      ...repository,
      includeBundle: false,
      restoreMode: "manual",
      omittedLocalCommitCount: 0
    };
  });
}

function summarizeRepositories(baseSummary, repositories) {
  return {
    ...baseSummary,
    repositoryCount: repositories.length,
    remoteRepositoryCount: repositories.filter((entry) => entry.restoreMode === "remote").length,
    bundledRepositoryCount: repositories.filter((entry) => entry.restoreMode === "bundle").length,
    manualRepositoryCount: repositories.filter((entry) => entry.restoreMode === "manual").length
  };
}

function createExportInspectionChecksum(portableConfig, repositories) {
  return checksumPackageCore({
    config: portableConfig,
    repositories: (repositories || []).map((repository) => ({
      id: repository.id,
      root: repository.root,
      remote: repository.remote,
      branch: repository.branch,
      commit: repository.commit,
      upstream: repository.upstream,
      remoteCommit: repository.remoteCommit,
      clean: repository.clean,
      ahead: repository.ahead,
      behind: repository.behind,
      state: repository.state,
      projectIds: repository.projectIds
    }))
  });
}

function buildProjectRepositoryBindings(config, repositories, roots) {
  const projectsById = new Map((config.projects || []).map((project) => [project.id, project]));
  const bindingsByProject = new Map();
  for (const repository of repositories || []) {
    if (!repository.root) continue;
    const sourceRoot = materializePathValue(repository.root, roots);
    for (const projectId of repository.projectIds || []) {
      const project = projectsById.get(projectId);
      if (!project) continue;
      const relativePaths = {};
      for (const field of PROJECT_STRING_PATH_FIELDS) {
        const value = String(project[field] || "").trim();
        if (!isAbsolutePath(value) || !isPathInside(value, sourceRoot)) continue;
        relativePaths[field] = normalizeRelativePath(path.relative(sourceRoot, path.resolve(value)) || ".");
      }
      const projectBindings = bindingsByProject.get(projectId) || [];
      projectBindings.push({
        repositoryId: repository.id,
        relativePaths
      });
      bindingsByProject.set(projectId, projectBindings);
    }
  }
  return [...bindingsByProject.entries()]
    .map(([projectId, repositoryBindings]) => ({ projectId, repositoryBindings }))
    .sort((left, right) => left.projectId.localeCompare(right.projectId, "zh-CN"));
}

function parseGitStatusV2(output) {
  const result = {
    branch: null,
    commit: null,
    upstream: null,
    clean: true,
    ahead: null,
    behind: null
  };
  for (const line of String(output || "").split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("# branch.oid ")) result.commit = line.slice(13).trim() || null;
    else if (line.startsWith("# branch.head ")) result.branch = line.slice(14).trim() || null;
    else if (line.startsWith("# branch.upstream ")) result.upstream = line.slice(18).trim() || null;
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        result.ahead = Number(match[1]);
        result.behind = Number(match[2]);
      }
    } else if (!line.startsWith("# ")) {
      result.clean = false;
    }
  }
  if (result.branch === "(detached)") result.branch = null;
  return result;
}

function repositoryBlockers(repositories) {
  const blockers = [];
  for (const repository of repositories) {
    const label = repository.root || repository.remote || "未知仓库";
    if (repository.state !== "git") continue;
    if (!repository.clean) blockers.push(issue("dirty_repository", `${label} 存在未提交或未跟踪文件`, { root: repository.root }));
    if (/^[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i.test(String(repository.remote || ""))) {
      blockers.push(issue("credentialed_remote", `${label} 的远端地址包含内嵌凭据，请先改为不含凭据的地址`));
    }
  }
  return blockers;
}

function repositoryWarnings(repositories) {
  const warnings = [];
  for (const repository of repositories) {
    const label = repository.root || repository.remote || "未知仓库";
    if (repository.state === "not_detected") {
      warnings.push(issue(
        "repository_not_detected",
        repository.remote
          ? `${label} 未检测到本地 Git 仓库，将依据配置的远端地址恢复`
          : `${label} 未检测到 Git 仓库，迁移包不会复制该目录`
      ));
    }
    if (repository.restoreMode === "bundle") {
      warnings.push(issue(
        "offline_bundle",
        `${label} 将生成一次离线 Git Bundle，供 ${repository.projectIds?.length || 0} 个关联项目共用`
      ));
    }
    if (repository.restoreMode === "manual") {
      warnings.push(issue("manual_restore", `${label} 无法自动恢复，需要在新电脑手动准备`));
    }
    if (Number(repository.omittedLocalCommitCount || 0) > 0) {
      warnings.push(issue(
        "local_commits_omitted",
        `${label} 未加入离线包，将不包含本地未推送的 ${repository.omittedLocalCommitCount} 个提交`
      ));
    }
    if (repository.bundleEligible && repository.restoreMode === "manual") {
      warnings.push(issue("bundle_skipped_manual", `${label} 已取消离线包且没有可验证的上游，需要手动复制仓库`));
    }
    if (Number(repository.behind || 0) > 0) {
      warnings.push(issue("repository_behind", `${label} 比上游落后 ${repository.behind} 个提交`));
    }
  }
  return warnings;
}

function sensitiveConfigBlockers(config) {
  const blockers = [];
  const sensitiveKeyPattern = /(password|passwd|token|api[_-]?key|secret|credential|private[_-]?key)/i;
  const sensitiveValuePatterns = [
    /(?:password|passwd|token|api[_-]?key|secret)\s*[:=]\s*\S+/i,
    /\b(?:ghp_|github_pat_|sk-)[a-z0-9_-]{12,}/i,
    /:\/\/[^\s/:]+:[^\s/@]+@/i
  ];

  function visit(value, location) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const nextLocation = location ? `${location}.${key}` : key;
        if (sensitiveKeyPattern.test(key) && item !== null && item !== undefined && String(item).trim()) {
          blockers.push(issue("suspected_secret", `${nextLocation} 可能包含敏感凭据，第一期迁移包不会导出该内容`));
        }
        visit(item, nextLocation);
      }
      return;
    }
    if (typeof value === "string" && sensitiveValuePatterns.some((pattern) => pattern.test(value))) {
      blockers.push(issue("suspected_secret", `${location || "配置"} 可能包含敏感凭据，第一期迁移包不会导出该内容`));
    }
  }

  visit(config, "config");
  return dedupeIssues(blockers);
}

function inspectConfiguredPaths(config, roots, fsApi = fs) {
  const externalPaths = [];
  const missingPaths = [];
  let portablePathCount = 0;
  for (const project of config.projects || []) {
    for (const [field, value] of projectPathValues(project)) {
      if (!isAbsolutePath(value)) continue;
      const portable = Object.values(roots || {}).some((root) => isPathInside(value, root));
      if (portable) portablePathCount += 1;
      else externalPaths.push({ projectId: project.id, field, path: value });
      if (!safeExists(value, fsApi)) missingPaths.push({ projectId: project.id, field, path: value });
    }
  }
  return {
    portablePathCount,
    externalPaths,
    missingPaths,
    warnings: [
      ...externalPaths.map((entry) => issue("external_absolute_path", `${entry.projectId} 的 ${entry.field} 位于项目根目录之外：${entry.path}`, entry)),
      ...missingPaths.map((entry) => issue("missing_path", `${entry.projectId} 的 ${entry.field} 不存在：${entry.path}`, entry))
    ]
  };
}

function inspectImportRepositories(repositories = [], mappings, options = {}) {
  const fsApi = options.fs || fs;
  const runGit = options.runGit || runGitCommand;
  return repositories.map((repository) => {
    const targetRoot = materializePathValue(repository.root || "", mappings);
    const warnings = [];
    const blockers = [];
    let state = "missing";
    let actualRemote = null;
    if (repository.restoreMode === "manual") {
      if (targetRoot && safeExists(targetRoot, fsApi)) {
        return {
          ...repository,
          root: targetRoot,
          actualRemote,
          state: "manual_ready",
          blockers,
          warnings: [issue("manual_repository_ready", `${targetRoot} 已由用户手动准备，将直接复用`)]
        };
      }
      return {
        ...repository,
        root: targetRoot,
        actualRemote,
        state: "manual",
        blockers: [issue("repository_not_restorable", `${targetRoot || repository.root} 不属于 Git 仓库，需要先手动复制到新电脑`)],
        warnings
      };
    }
    const mappedRoots = Object.values(mappings || {}).filter(Boolean);
    if (!targetRoot || !isAbsolutePath(targetRoot) || !mappedRoots.some((root) => isPathInside(targetRoot, root))) {
      return {
        ...repository,
        root: targetRoot,
        actualRemote,
        state: "outside_projects_root",
        blockers: [issue("repository_outside_projects_root", `${targetRoot || repository.root} 位于映射的项目根目录之外`)],
        warnings
      };
    }
    if (targetRoot && safeExists(targetRoot, fsApi)) {
      const gitRoot = findGitRoot(targetRoot, fsApi);
      if (gitRoot && samePath(gitRoot, targetRoot)) {
        state = "ready";
        actualRemote = runGit(targetRoot, ["remote", "get-url", "origin"]) || null;
        if (repository.remote && actualRemote && normalizeRemote(repository.remote) !== normalizeRemote(actualRemote)) {
          state = "remote_mismatch";
          blockers.push(issue("remote_mismatch", `${targetRoot} 的 origin 与迁移包不一致`));
        }
        if (repository.commit && !runGit(targetRoot, ["rev-parse", "--verify", `${repository.commit}^{commit}`])) {
          state = "commit_missing";
          blockers.push(issue("commit_missing", `${targetRoot} 缺少迁移包要求的提交 ${repository.commit}`));
        }
      } else {
        state = "not_git";
        blockers.push(issue("target_not_git", `${targetRoot} 已存在，但不是对应的 Git 仓库`));
      }
    } else {
      const bundlePath = repository.bundle?.file && options.extractionDirectory
        ? path.resolve(options.extractionDirectory, ...String(repository.bundle.file).split("/"))
        : "";
      const canRestoreBundle = repository.restoreMode === "bundle"
        && bundlePath
        && isPathInside(bundlePath, options.extractionDirectory)
        && safeExists(bundlePath, fsApi);
      const canRestoreRemote = repository.restoreMode === "remote" && Boolean(repository.remote);
      if (canRestoreBundle || canRestoreRemote) {
        state = "restorable";
        warnings.push(issue(
          "repository_will_restore",
          `${targetRoot || repository.root} 将从${canRestoreBundle ? "离线 Bundle" : "远端仓库"}恢复一次，供 ${repository.projectIds?.length || 0} 个项目共用`
        ));
      } else {
        state = "manual";
        blockers.push(issue("repository_not_restorable", `${targetRoot || repository.root} 缺少可用的自动恢复来源`));
      }
    }
    return {
      ...repository,
      root: targetRoot,
      actualRemote,
      state,
      blockers,
      warnings
    };
  });
}

function inspectDependencies(options = {}) {
  const runGit = options.runGit || runGitCommand;
  const runCommand = options.runCommand || runExecutableCommand;
  return {
    operatingSystem: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch
    },
    runtimes: {
      node: process.version,
      requiredNode: packageJson.engines?.node || null,
      git: firstLine(runGit(ROOT_DIR, ["--version"])) || null,
      npm: firstLine(runCommand("npm", ["--version"])) || null,
      python: firstLine(runCommand("py", ["-3", "--version"]) || runCommand("python", ["--version"])) || null,
      githubCli: firstLine(runCommand("gh", ["--version"])) || null,
      codex: firstLine(runCommand("codex", ["--version"])) || null
    }
  };
}

function validateMigrationRepositoryManifest(migrationPackage) {
  const repositoryIds = new Set();
  for (const repository of migrationPackage.repositories) {
    if (!repository || !/^repo-[a-f0-9]{12}$/i.test(String(repository.id || "")) || repositoryIds.has(repository.id)) {
      throw new MigrationError("迁移包包含无效或重复的仓库 ID");
    }
    repositoryIds.add(repository.id);
    if (!String(repository.root || "").trim()) throw new MigrationError(`仓库 ${repository.id} 缺少目标路径`);
    if (!["remote", "bundle", "manual"].includes(repository.restoreMode)) {
      throw new MigrationError(`仓库 ${repository.id} 的恢复方式无效`);
    }
    if (repository.commit && !/^[a-f0-9]{40,64}$/i.test(String(repository.commit))) {
      throw new MigrationError(`仓库 ${repository.id} 的提交标识无效`);
    }
    if (repository.restoreMode === "remote" && !String(repository.remote || "").trim()) {
      throw new MigrationError(`仓库 ${repository.id} 缺少远端地址`);
    }
  }

  const projectIds = new Set(migrationPackage.config.projects.map((project) => project.id));
  for (const binding of migrationPackage.projectRepositoryBindings) {
    if (!projectIds.has(binding?.projectId) || !Array.isArray(binding?.repositoryBindings)) {
      throw new MigrationError("迁移包包含无效的项目仓库绑定");
    }
    for (const repositoryBinding of binding.repositoryBindings) {
      if (!repositoryIds.has(repositoryBinding?.repositoryId)) {
        throw new MigrationError(`项目 ${binding.projectId} 引用了未知仓库`);
      }
      for (const relativePath of Object.values(repositoryBinding.relativePaths || {})) {
        const normalized = String(relativePath || ".").replace(/\\/g, "/");
        if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
          throw new MigrationError(`项目 ${binding.projectId} 包含无效的仓库相对路径`);
        }
      }
    }
  }
}

function publicExportPreview(preview) {
  return {
    canExport: preview.canExport,
    inspectionChecksum: preview.inspectionChecksum,
    roots: preview.roots,
    repositories: preview.repositories,
    projectRepositoryBindings: preview.projectRepositoryBindings,
    blockers: preview.blockers,
    warnings: preview.warnings,
    summary: preview.summary
  };
}

function projectCandidateDirectories(project, fsApi) {
  const candidates = [];
  for (const field of ["codexCwd", "cwd", "path", "command"]) {
    const value = String(project?.[field] || "").trim();
    if (!isAbsolutePath(value)) continue;
    let candidate = value;
    try {
      if (fsApi.existsSync(value) && fsApi.statSync(value).isFile()) candidate = path.dirname(value);
      else if (!fsApi.existsSync(value) && path.extname(value)) candidate = path.dirname(value);
    } catch {
      candidate = path.dirname(value);
    }
    if (!candidates.some((item) => samePath(item, candidate))) candidates.push(path.resolve(candidate));
  }
  return candidates;
}

function inferProjectDirectory(project) {
  const value = project.codexCwd || project.cwd || project.path || project.command || "";
  if (!isAbsolutePath(value)) return "";
  return path.extname(value) ? path.dirname(value) : value;
}

function findGitRoot(startDirectory, fsApi = fs) {
  if (!startDirectory || !isAbsolutePath(startDirectory)) return null;
  let current = path.resolve(startDirectory);
  while (true) {
    if (safeExists(path.join(current, ".git"), fsApi)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function runGitCommand(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function runExecutableCommand(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000
  });
  if (result.status !== 0) return "";
  return String(result.stdout || result.stderr || "").trim();
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/, 1)[0].trim();
}

function projectPathValues(project) {
  const values = [];
  for (const field of PROJECT_STRING_PATH_FIELDS) {
    if (typeof project?.[field] === "string") values.push([field, project[field]]);
  }
  for (const field of PROJECT_ARRAY_PATH_FIELDS) {
    for (const value of Array.isArray(project?.[field]) ? project[field] : []) {
      if (typeof value === "string") values.push([field, value]);
    }
  }
  return values;
}

function checksumPackageCore(core) {
  return crypto.createHash("sha256").update(stableStringify(core), "utf8").digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJsonFile(filePath, fsApi = fs) {
  const content = fsApi.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(content);
}

function normalizeRemote(value) {
  return String(value || "")
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function normalizeRelativePath(value) {
  const normalized = String(value || ".").replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized || ".";
}

function isPathInside(value, root) {
  const target = trimTrailingSeparator(path.resolve(value)).toLowerCase();
  const base = trimTrailingSeparator(path.resolve(root)).toLowerCase();
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function isAbsolutePath(value) {
  const text = String(value || "").trim();
  return path.isAbsolute(text) || path.win32.isAbsolute(text) || path.posix.isAbsolute(text);
}

function safeExists(value, fsApi = fs) {
  try {
    return fsApi.existsSync(value);
  } catch {
    return false;
  }
}

function samePath(left, right) {
  return trimTrailingSeparator(path.resolve(left)).toLowerCase() === trimTrailingSeparator(path.resolve(right)).toLowerCase();
}

function trimTrailingSeparator(value) {
  const text = String(value || "");
  const parsed = path.parse(text);
  if (text === parsed.root) return text;
  return text.replace(/[\\/]+$/, "");
}

function walkStrings(value, callback) {
  if (typeof value === "string") {
    callback(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walkStrings(item, callback));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => walkStrings(item, callback));
  }
}

function issue(code, message, details = null) {
  return { code, message, ...(details ? { details } : {}) };
}

function dedupeIssues(issues) {
  const seen = new Set();
  return (issues || []).filter((entry) => {
    const key = `${entry.code}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileTimestamp(value) {
  return String(value).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

module.exports = {
  MIGRATION_FORMAT,
  MIGRATION_SCHEMA_VERSION,
  MigrationError,
  applyRepositorySelections,
  checksumPackageCore,
  collectUnresolvedVariables,
  createMigrationPackage,
  createMigrationService,
  buildProjectRepositoryBindings,
  inspectConfiguredPaths,
  materializePathValue,
  parseGitStatusV2,
  portableizePathValue,
  resolveImportMappings,
  prepareRepositories,
  signMigrationPackage,
  sensitiveConfigBlockers,
  stableStringify,
  transformConfigPaths,
  validateImportedConfig,
  verifyMigrationPackage
};
