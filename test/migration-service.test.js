const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  createMigrationPackage,
  createMigrationService,
  materializePathValue,
  parseGitStatusV2,
  portableizePathValue,
  sensitiveConfigBlockers,
  transformConfigPaths,
  validateImportedConfig,
  verifyMigrationPackage
} = require("../server/migration-service");
const { validateArchiveEntry } = require("../server/migration-archive");

function sampleConfig() {
  return {
    server: { host: "127.0.0.1", port: 3344 },
    security: { allowOnlyConfiguredProjects: true },
    categories: [{ id: "development", name: "开发", order: 0 }],
    projects: [{
      id: "demo",
      name: "Demo",
      type: "cmd",
      category: "development",
      cwd: "D:\\Projects\\Demo",
      command: "D:\\Projects\\Demo\\scripts\\start.bat",
      codexCwd: "D:\\Projects\\Demo",
      port: 3000,
      auxiliaryPorts: [8000],
      processMatch: ["D:\\Projects\\Demo", "--port 3000"]
    }]
  };
}

test("project paths are portableized and materialized through PROJECTS_ROOT", () => {
  const roots = { PROJECTS_ROOT: "D:\\Projects" };
  assert.equal(
    portableizePathValue("D:\\Projects\\Demo\\start.bat", roots),
    "${PROJECTS_ROOT}\\Demo\\start.bat"
  );
  assert.equal(
    materializePathValue("${PROJECTS_ROOT}\\Demo\\start.bat", { PROJECTS_ROOT: "E:\\Work" }),
    "E:\\Work\\Demo\\start.bat"
  );

  const portable = transformConfigPaths(sampleConfig(), (value) => portableizePathValue(value, roots));
  assert.equal(portable.projects[0].cwd, "${PROJECTS_ROOT}\\Demo");
  assert.equal(portable.projects[0].command, "${PROJECTS_ROOT}\\Demo\\scripts\\start.bat");
  assert.equal(portable.projects[0].processMatch[0], "${PROJECTS_ROOT}\\Demo");
});

test("migration package checksum detects any configuration change", () => {
  const migrationPackage = createMigrationPackage({
    createdAt: "2026-08-02T12:00:00.000Z",
    config: sampleConfig(),
    roots: { PROJECTS_ROOT: "D:\\Projects" },
    repositories: [],
    dependencies: {},
    warnings: []
  });

  assert.equal(verifyMigrationPackage(migrationPackage), true);
  const tampered = JSON.parse(JSON.stringify(migrationPackage));
  tampered.config.projects[0].port = 3999;
  assert.throws(() => verifyMigrationPackage(tampered), /完整性校验失败/);
});

test("migration service exports a clean manifest and applies a checked import", () => {
  let writtenConfig = null;
  const service = createMigrationService({
    projectsRoot: "D:\\Projects",
    readConfig: sampleConfig,
    writeConfig(config) {
      writtenConfig = config;
      return { backupFile: "config/backups/projects.test.json" };
    },
    inspectRepositories() {
      return [{
        root: "${PROJECTS_ROOT}\\Demo",
        remote: "git@github.com:example/demo.git",
        branch: "main",
        commit: "a".repeat(40),
        upstream: "origin/main",
        clean: true,
        ahead: 0,
        behind: 0,
        state: "git",
        projectIds: ["demo"]
      }];
    },
    inspectDependencies() {
      return { runtimes: { node: "v20.0.0" } };
    },
    now() {
      return new Date("2026-08-02T12:00:00.000Z");
    }
  });

  const exported = service.exportPackage();
  assert.equal(exported.fileName, "project-workbench-20260802T120000Z.plwmigrate");
  assert.equal(exported.package.config.projects[0].cwd, "${PROJECTS_ROOT}\\Demo");

  const inspected = service.inspectImport(exported.package, { PROJECTS_ROOT: "E:\\Work" });
  assert.equal(inspected.canApply, true);
  assert.equal(inspected.resolvedConfig.projects[0].cwd, "E:\\Work\\Demo");
  assert.ok(inspected.warnings.some((entry) => entry.code === "repository_will_restore"));

  const applied = service.applyImport(
    exported.package,
    { PROJECTS_ROOT: "E:\\Work" },
    exported.package.integrity.checksum
  );
  assert.equal(applied.backupFile, "config/backups/projects.test.json");
  assert.equal(writtenConfig.projects[0].command, "E:\\Work\\Demo\\scripts\\start.bat");
});

test("import validation rejects duplicate project ports", () => {
  const config = sampleConfig();
  config.projects.push({
    id: "second",
    name: "Second",
    type: "cmd",
    category: "development",
    command: "npm start",
    port: 3000
  });
  const blockers = validateImportedConfig(config);
  assert.ok(blockers.some((entry) => entry.code === "duplicate_port"));
});

test("import validation includes ports inferred from project URLs", () => {
  const config = sampleConfig();
  config.projects[0].port = undefined;
  config.projects[0].url = "http://localhost:3100";
  config.projects.push({
    id: "second",
    name: "Second",
    type: "url",
    category: "development",
    url: "http://localhost:3100"
  });
  const blockers = validateImportedConfig(config);
  assert.ok(blockers.some((entry) => entry.code === "duplicate_port"));
});

test("phase one export blocks suspected credentials without exposing their values", () => {
  const config = sampleConfig();
  config.projects[0].args = ["--api-key=sk-example-sensitive-value"];
  const blockers = sensitiveConfigBlockers(config);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "suspected_secret");
  assert.equal(blockers[0].message.includes("sk-example-sensitive-value"), false);
});

test("git porcelain v2 status provides branch sync and dirty state in one read", () => {
  const status = parseGitStatusV2([
    "# branch.oid abcdef123456",
    "# branch.head feature/migration",
    "# branch.upstream origin/feature/migration",
    "# branch.ab +2 -3",
    "1 .M N... 100644 100644 100644 abc def server/index.js"
  ].join("\n"));
  assert.deepEqual(status, {
    branch: "feature/migration",
    commit: "abcdef123456",
    upstream: "origin/feature/migration",
    clean: false,
    ahead: 2,
    behind: 3
  });
});

test("optional bundle selection preserves HEAD or falls back to the inspected upstream commit", () => {
  const localCommit = "b".repeat(40);
  const remoteCommit = "a".repeat(40);
  const service = createMigrationService({
    projectsRoot: "D:\\Projects",
    readConfig: sampleConfig,
    inspectDependencies: () => ({}),
    inspectRepositories: () => [{
      root: "${PROJECTS_ROOT}\\Demo",
      remote: "git@github.com:example/demo.git",
      branch: "main",
      commit: localCommit,
      upstream: "origin/main",
      remoteCommit,
      clean: true,
      ahead: 2,
      behind: 0,
      state: "git",
      projectIds: ["demo"]
    }]
  });

  const preview = service.inspectExport();
  const repository = preview.repositories[0];
  assert.equal(repository.defaultIncludeBundle, true);
  assert.equal(repository.bundleReason, "unpushed_commits");

  const bundled = service.exportPackage({
    inspectionChecksum: preview.inspectionChecksum,
    repositorySelections: [{ repositoryId: repository.id, includeBundle: true }]
  });
  assert.equal(bundled.package.repositories[0].restoreMode, "bundle");
  assert.equal(bundled.package.repositories[0].commit, localCommit);

  const remoteOnly = service.exportPackage({
    inspectionChecksum: preview.inspectionChecksum,
    repositorySelections: [{ repositoryId: repository.id, includeBundle: false }]
  });
  assert.equal(remoteOnly.package.repositories[0].restoreMode, "remote");
  assert.equal(remoteOnly.package.repositories[0].commit, remoteCommit);
  assert.equal(remoteOnly.package.repositories[0].omittedLocalCommitCount, 2);
  assert.ok(remoteOnly.package.warnings.some((entry) => entry.code === "local_commits_omitted"));
});

test("repository without an upstream becomes manual when its optional bundle is unchecked", () => {
  const service = createMigrationService({
    projectsRoot: "D:\\Projects",
    readConfig: sampleConfig,
    inspectDependencies: () => ({}),
    inspectRepositories: () => [{
      root: "${PROJECTS_ROOT}\\Demo",
      remote: null,
      branch: "main",
      commit: "c".repeat(40),
      upstream: null,
      remoteCommit: null,
      clean: true,
      ahead: null,
      behind: null,
      state: "git",
      projectIds: ["demo"]
    }]
  });
  const preview = service.inspectExport();
  const repository = preview.repositories[0];
  const exported = service.exportPackage({
    inspectionChecksum: preview.inspectionChecksum,
    repositorySelections: [{ repositoryId: repository.id, includeBundle: false }]
  });
  assert.equal(exported.package.repositories[0].restoreMode, "manual");
  assert.equal(exported.preview.summary.bundledRepositoryCount, 0);
  assert.equal(exported.preview.summary.manualRepositoryCount, 1);
  assert.ok(exported.package.warnings.some((entry) => entry.code === "bundle_skipped_manual"));
});

test("export rejects a stale scan and dirty repositories regardless of bundle choice", () => {
  let commit = "d".repeat(40);
  let clean = true;
  const service = createMigrationService({
    projectsRoot: "D:\\Projects",
    readConfig: sampleConfig,
    inspectDependencies: () => ({}),
    inspectRepositories: () => [{
      root: "${PROJECTS_ROOT}\\Demo",
      remote: null,
      branch: "main",
      commit,
      upstream: null,
      remoteCommit: null,
      clean,
      ahead: null,
      behind: null,
      state: "git",
      projectIds: ["demo"]
    }]
  });
  const preview = service.inspectExport();
  const repositoryId = preview.repositories[0].id;
  commit = "e".repeat(40);
  assert.throws(() => service.exportPackage({
    inspectionChecksum: preview.inspectionChecksum,
    repositorySelections: [{ repositoryId, includeBundle: false }]
  }), /扫描后发生了变化/);

  const freshPreview = service.inspectExport();
  clean = false;
  assert.throws(() => service.exportPackage({
    repositorySelections: [{ repositoryId, includeBundle: false }]
  }), /检查未通过/);
  assert.notEqual(freshPreview.inspectionChecksum, service.inspectExport().inspectionChecksum);
});

test("shared repository is bundled and restored only once for multiple projects", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plw-migration-test-"));
  const sourceProjectsRoot = path.join(temporaryRoot, "source");
  const repositoryRoot = path.join(sourceProjectsRoot, "SharedRepo");
  const targetProjectsRoot = path.join(temporaryRoot, "target");
  const scriptOne = path.join(repositoryRoot, "strategy-one", "start.bat");
  const scriptTwo = path.join(repositoryRoot, "strategy-two", "start.bat");
  let writtenConfig = null;
  let artifact = null;
  let artifactWithoutBundle = null;

  try {
    fs.mkdirSync(path.dirname(scriptOne), { recursive: true });
    fs.mkdirSync(path.dirname(scriptTwo), { recursive: true });
    fs.writeFileSync(scriptOne, "@echo off\r\n", "utf8");
    fs.writeFileSync(scriptTwo, "@echo off\r\n", "utf8");
    runGit(repositoryRoot, ["init", "-b", "main"]);
    runGit(repositoryRoot, ["config", "user.name", "Migration Test"]);
    runGit(repositoryRoot, ["config", "user.email", "migration@example.test"]);
    runGit(repositoryRoot, ["add", "."]);
    runGit(repositoryRoot, ["commit", "-m", "initial"]);

    const config = {
      server: { host: "127.0.0.1", port: 3344 },
      security: { allowOnlyConfiguredProjects: true },
      categories: [{ id: "strategy", name: "策略", order: 0 }],
      projects: [
        {
          id: "strategy-one",
          name: "Strategy One",
          type: "bat",
          category: "strategy",
          path: scriptOne,
          cwd: path.dirname(scriptOne),
          codexCwd: path.dirname(scriptOne),
          port: 3801
        },
        {
          id: "strategy-two",
          name: "Strategy Two",
          type: "bat",
          category: "strategy",
          path: scriptTwo,
          cwd: path.dirname(scriptTwo),
          codexCwd: path.dirname(scriptTwo),
          port: 3802
        }
      ]
    };
    const service = createMigrationService({
      projectsRoot: sourceProjectsRoot,
      readConfig: () => config,
      writeConfig(nextConfig) {
        writtenConfig = nextConfig;
        return { backupFile: "backup.json" };
      },
      inspectDependencies: () => ({})
    });

    const preview = service.inspectExport();
    assert.equal(preview.summary.repositoryCount, 1);
    assert.equal(preview.summary.bundledRepositoryCount, 1);
    assert.equal(preview.repositories[0].projectIds.length, 2);
    assert.equal(preview.projectRepositoryBindings.length, 2);
    assert.equal(
      preview.projectRepositoryBindings[0].repositoryBindings[0].repositoryId,
      preview.projectRepositoryBindings[1].repositoryBindings[0].repositoryId
    );

    artifactWithoutBundle = service.exportArchive({
      inspectionChecksum: preview.inspectionChecksum,
      repositorySelections: [{
        repositoryId: preview.repositories[0].id,
        includeBundle: false
      }]
    });
    const listingWithoutBundle = spawnSync("tar", ["-tzf", artifactWithoutBundle.archivePath], { encoding: "utf8" });
    assert.equal(listingWithoutBundle.status, 0, listingWithoutBundle.stderr);
    assert.equal((listingWithoutBundle.stdout.match(/\.bundle\r?$/gm) || []).length, 0);
    assert.equal(artifactWithoutBundle.migrationPackage.repositories[0].restoreMode, "manual");

    artifact = service.exportArchive();
    const archiveListing = spawnSync("tar", ["-tzf", artifact.archivePath], { encoding: "utf8" });
    assert.equal(archiveListing.status, 0, archiveListing.stderr);
    assert.equal((archiveListing.stdout.match(/\.bundle\r?$/gm) || []).length, 1);

    const inspection = service.inspectImportArchive(artifact.archivePath, {
      PROJECTS_ROOT: targetProjectsRoot
    });
    assert.equal(inspection.canApply, true);
    assert.equal(inspection.repositories.length, 1);
    assert.equal(inspection.repositories[0].state, "restorable");

    const applied = service.applyImportArchive(
      inspection.importToken,
      { PROJECTS_ROOT: targetProjectsRoot },
      inspection.checksum
    );
    assert.equal(applied.createdRepositoryCount, 1);
    assert.ok(fs.existsSync(path.join(targetProjectsRoot, "SharedRepo", "strategy-one", "start.bat")));
    assert.ok(fs.existsSync(path.join(targetProjectsRoot, "SharedRepo", "strategy-two", "start.bat")));
    assert.equal(writtenConfig.projects[0].cwd, path.join(targetProjectsRoot, "SharedRepo", "strategy-one"));
  } finally {
    artifact?.cleanup?.();
    artifactWithoutBundle?.cleanup?.();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("migration archive rejects path traversal entries", () => {
  assert.throws(() => validateArchiveEntry("../manifest.json"), /不安全路径/);
  assert.throws(() => validateArchiveEntry("repositories/../../outside.bundle"), /不安全路径/);
  assert.equal(validateArchiveEntry("repositories/repo-0123456789ab.bundle"), "repositories/repo-0123456789ab.bundle");
});

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}
