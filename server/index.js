const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { findProject, loadConfig, ROOT_DIR } = require("./config");
const {
  createCategory,
  createProject,
  deleteCategory,
  deleteProject,
  reorderCategories,
  reorderProjects,
  updateCategory,
  updateProject,
  validateProjectInput
} = require("./config-manager");
const { ProjectRunner } = require("./project-runner");
const { checkProjectStatus, findListeningPorts, getWindowsProcessesAsync } = require("./status-checker");
const { checkSystemHealth } = require("./system-health");
const { createCodexUsageService } = require("./codex-usage");
const { createMigrationService } = require("./migration-service");
const { createUploadPath } = require("./migration-archive");

const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const runner = new ProjectRunner();
const codexUsageService = createCodexUsageService();
const migrationService = createMigrationService();
const activeProjectActions = new Map();
const MAX_JSON_BODY_LENGTH = 4 * 1024 * 1024;
const MAX_MIGRATION_ARCHIVE_LENGTH = 2 * 1024 * 1024 * 1024;

function logFatalRuntimeError(kind, error) {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error(`[${new Date().toISOString()}] ${kind}: ${detail}`);
}

// Record fatal failures without pretending an unknown exception is safe to
// continue after. The tray watchdog will start a clean backend process.
process.on("uncaughtExceptionMonitor", (error) => {
  logFatalRuntimeError("uncaught exception", error);
});
process.on("unhandledRejection", (reason) => {
  logFatalRuntimeError("unhandled rejection", reason);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});

async function inspectProject(project, projects, options = {}) {
  const processes = Array.isArray(options.processes)
    ? options.processes
    : await getWindowsProcessesAsync();
  const inspectOptions = { ...options, processes };
  runner.reconcileProjectProcesses(project, { processes });
  let runtime = runner.getRuntimeState(project.id, { processes });
  let projectStatus = await checkProjectStatus(project, runtime, { ...inspectOptions, projects });

  if (projectStatus.selfManaged && runner.clearInactiveRuntimeState(project.id, { processes })) {
    runtime = null;
    projectStatus = await checkProjectStatus(project, runtime, { ...inspectOptions, projects });
  }

  if (
    projectStatus.ownedPortPids?.length
    && runner.trackServicePids(project.id, projectStatus.ownedPortPids, { processes })
  ) {
    runtime = runner.getRuntimeState(project.id, { processes });
    projectStatus = await checkProjectStatus(project, runtime, { ...inspectOptions, projects });
  }

  return { projectStatus, runtime };
}

async function handleApi(req, res, url) {
  const config = loadConfig();
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/server/ping") {
    const actions = [...activeProjectActions.entries()].map(([projectId, action]) => ({
      projectId,
      action
    }));
    return sendJson(res, {
      ok: true,
      service: "project-launcher-workbench",
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      busy: actions.length > 0,
      activeProjectActions: actions
    });
  }

  if (req.method === "GET" && pathname === "/api/projects") {
    return sendJson(res, {
      projects: config.projects,
      categories: config.categories,
      server: config.server,
      security: config.security
    });
  }

  if (req.method === "GET" && pathname === "/api/status/all") {
    const statuses = {};
    const [listeners, processes] = await Promise.all([
      findListeningPorts(),
      getWindowsProcessesAsync()
    ]);
    for (const project of config.projects) {
      const { projectStatus, runtime } = await inspectProject(project, config.projects, { listeners, processes });
      statuses[project.id] = {
        ...projectStatus,
        runtime
      };
    }
    return sendJson(res, { statuses });
  }

  if (req.method === "GET" && pathname === "/api/system/health") {
    return sendJson(res, await checkSystemHealth(config));
  }

  if (pathname === "/api/codex/usage") {
    if (req.method !== "GET") return sendError(res, 405, "Method not allowed");
    return sendJson(res, await codexUsageService.getUsage({
      force: url.searchParams.get("force") === "1"
    }));
  }

  if (pathname === "/api/codex/open") {
    if (req.method !== "POST") return sendError(res, 405, "Method not allowed");
    try {
      return sendJson(res, await runner.openCodexDesktopApp());
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === "/api/migration/export/inspect") {
    if (req.method !== "GET") return sendError(res, 405, "Method not allowed");
    try {
      return sendJson(res, migrationService.inspectExport());
    } catch (error) {
      return sendError(res, Number(error.statusCode) || 400, error.message, error.details);
    }
  }

  if (pathname === "/api/migration/export") {
    if (req.method !== "POST") return sendError(res, 405, "Method not allowed");
    try {
      const body = await readJsonBody(req);
      const artifact = migrationService.exportArchive({
        repositorySelections: body.repositorySelections,
        inspectionChecksum: body.inspectionChecksum
      });
      return sendFileDownload(res, artifact.archivePath, artifact.fileName, artifact.cleanup);
    } catch (error) {
      return sendError(res, Number(error.statusCode) || 400, error.message, error.details);
    }
  }

  if (pathname === "/api/migration/import/inspect") {
    if (req.method !== "POST") return sendError(res, 405, "Method not allowed");
    const uploadPath = createUploadPath();
    try {
      await receiveFileBody(req, uploadPath, MAX_MIGRATION_ARCHIVE_LENGTH);
      return sendJson(res, migrationService.inspectImportArchive(uploadPath, {
        PROJECTS_ROOT: url.searchParams.get("projectsRoot") || undefined
      }));
    } catch (error) {
      return sendError(res, Number(error.statusCode) || 400, error.message, error.details);
    } finally {
      fs.rmSync(uploadPath, { force: true });
    }
  }

  if (pathname === "/api/migration/import/apply") {
    if (req.method !== "POST") return sendError(res, 405, "Method not allowed");
    try {
      const listeners = await findListeningPorts();
      const runningProjectIds = [];
      for (const project of config.projects) {
        const { projectStatus } = await inspectProject(project, config.projects, { listeners });
        if (
          !projectStatus.selfManaged
          && ["running", "starting", "stopping", "alternate", "multi_instance"].includes(projectStatus.state)
        ) {
          runningProjectIds.push(project.id);
        }
      }
      if (runningProjectIds.length) {
        const error = new Error("仍有已登记项目正在运行，请全部停止后再导入配置");
        error.statusCode = 409;
        error.details = runningProjectIds;
        throw error;
      }
      const body = await readJsonBody(req);
      return sendJson(res, migrationService.applyImportArchive(
        body.importToken,
        body.rootMappings,
        body.expectedChecksum
      ));
    } catch (error) {
      return sendError(res, Number(error.statusCode) || 400, error.message, error.details);
    }
  }


  if (pathname === "/api/config/categories") {
    try {
      if (req.method === "GET") {
        return sendJson(res, { categories: config.categories, projects: config.projects });
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = createCategory(body.category || body);
        return sendJson(res, { ok: true, ...result });
      }

      return sendError(res, 405, "Method not allowed");
    } catch (error) {
      return sendError(res, 400, error.message, error.details);
    }
  }

  if (pathname === "/api/config/categories/reorder") {
    try {
      if (req.method !== "POST") {
        return sendError(res, 405, "Method not allowed");
      }

      const body = await readJsonBody(req);
      const result = reorderCategories(body.ids || body.categoryIds || body.order);
      return sendJson(res, { ok: true, ...result });
    } catch (error) {
      return sendError(res, 400, error.message, error.details);
    }
  }

  const categoryMatch = pathname.match(/^\/api\/config\/categories\/([^/]+)$/);
  if (categoryMatch) {
    const categoryId = decodeURIComponent(categoryMatch[1]);

    try {
      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const result = updateCategory(categoryId, body.category || body);
        return sendJson(res, { ok: true, ...result });
      }

      if (req.method === "DELETE") {
        const result = deleteCategory(categoryId);
        return sendJson(res, { ok: true, ...result });
      }

      return sendError(res, 405, "Method not allowed");
    } catch (error) {
      return sendError(res, 400, error.message, error.details);
    }
  }

  if (pathname === "/api/config/projects") {
    try {
      if (req.method === "GET") {
        return sendJson(res, { projects: config.projects, categories: config.categories });
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = createProject(body.project || body);
        return sendJson(res, { ok: true, ...result });
      }

      return sendError(res, 405, "Method not allowed");
    } catch (error) {
      return sendError(res, 400, error.message, error.details);
    }
  }

  if (pathname === "/api/config/validate-project" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const project = validateProjectInput(body.project || body, body.currentId || null);
      return sendJson(res, { ok: true, project });
    } catch (error) {
      return sendError(res, 400, error.message, error.details);
    }
  }

  if (pathname === "/api/config/projects/reorder") {
    try {
      if (req.method !== "POST") {
        return sendError(res, 405, "Method not allowed");
      }

      const body = await readJsonBody(req);
      const result = reorderProjects(body.ids || body.projectIds || body.order);
      return sendJson(res, { ok: true, ...result });
    } catch (error) {
      return sendError(res, 400, error.message, error.details);
    }
  }

  const configMatch = pathname.match(/^\/api\/config\/projects\/([^/]+)$/);
  if (configMatch) {
    const projectId = decodeURIComponent(configMatch[1]);

    try {
      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const result = updateProject(projectId, body.project || body);
        return sendJson(res, { ok: true, ...result });
      }

      if (req.method === "DELETE") {
        const runtime = runner.getRuntimeState(projectId);
        if (runtime?.running) {
          return sendError(res, 400, "\u9879\u76ee\u6b63\u5728\u8fd0\u884c\uff0c\u8bf7\u5148\u505c\u6b62\u540e\u518d\u5220\u9664");
        }

        const result = deleteProject(projectId);
        return sendJson(res, { ok: true, ...result });
      }

      return sendError(res, 405, "Method not allowed");
    } catch (error) {
      return sendError(res, 400, error.message, error.details);
    }
  }

  const match = pathname.match(/^\/api\/projects\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return sendError(res, 404, "API not found");
  }

  const projectId = decodeURIComponent(match[1]);
  const action = match[2];
  const project = findProject(config, projectId);
  if (!project) {
    return sendError(res, 404, "\u9879\u76ee\u4e0d\u5b58\u5728");
  }

  try {
    if (req.method === "GET" && action === "status") {
      const listeners = await findListeningPorts();
      const { projectStatus, runtime } = await inspectProject(project, config.projects, { listeners });
      return sendJson(res, {
        id: project.id,
        status: projectStatus,
        runtime
      });
    }

    if (req.method === "GET" && action === "logs") {
      const logs = await runner.readLogs(project);
      return sendJson(res, { id: project.id, logs });
    }

    if (req.method !== "POST") {
      return sendError(res, 405, "Method not allowed");
    }

    if (action === "start") {
      const result = await runProjectAction(project.id, action, () => (
        runner.startProject(project, { projects: config.projects })
      ));
      return sendJson(res, result);
    }

    if (action === "stop") {
      const result = await runProjectAction(project.id, action, () => runner.stopProject(project));
      return sendJson(res, result);
    }

    if (action === "restart") {
      const result = await runProjectAction(project.id, action, () => (
        runner.restartProject(project, { projects: config.projects })
      ));
      return sendJson(res, result);
    }

    if (action === "stop-alternate-instances") {
      const body = await readJsonBody(req);
      const result = await runProjectAction(project.id, action, () => (
        runner.stopAlternateInstances(project, {
          expectedInstances: body.expectedInstances,
          projects: config.projects
        })
      ));
      return sendJson(res, result);
    }

    if (action === "stop-port-owner" || action === "restart-port-owner") {
      const body = await readJsonBody(req);
      const options = {
        expectedPids: body.expectedPids,
        projects: config.projects
      };
      const result = await runProjectAction(project.id, action, () => (
        action === "restart-port-owner"
          ? runner.restartPortOwner(project, options)
          : runner.stopPortOwner(project, options)
      ));
      return sendJson(res, result);
    }

    if (action === "adopt") {
      const result = await runProjectAction(project.id, action, () => (
        runner.adoptProject(project, { projects: config.projects })
      ));
      const listeners = await findListeningPorts();
      const { projectStatus, runtime } = await inspectProject(project, config.projects, { listeners });
      return sendJson(res, {
        ...result,
        status: projectStatus,
        runtime
      });
    }

    if (action === "open-url") {
      if (!project.url) {
        return sendError(res, 400, "\u9879\u76ee\u672a\u914d\u7f6e url");
      }
      const result = await runner.openProject({ ...project, type: "url" });
      return sendJson(res, result);
    }

    if (action === "open-folder") {
      const result = await runner.openFolder(project);
      return sendJson(res, result);
    }

    if (action === "open-codex") {
      const result = await runner.openCodex(project);
      return sendJson(res, result);
    }

    return sendError(res, 404, "API action not found");
  } catch (error) {
    return sendError(res, Number(error.statusCode) || 400, error.message, error.details);
  }
}

async function runProjectAction(projectId, action, callback) {
  const active = activeProjectActions.get(projectId);
  if (active) {
    const error = new Error("项目正在执行“" + active + "”操作，请稍后重试");
    error.statusCode = 409;
    throw error;
  }

  activeProjectActions.set(projectId, action);
  try {
    return await callback();
  } finally {
    if (activeProjectActions.get(projectId) === action) {
      activeProjectActions.delete(projectId);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_LENGTH) {
        req.destroy();
        reject(new Error("\u8bf7\u6c42\u4f53\u8fc7\u5927"));
      }
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON \u8bf7\u6c42\u4f53\u683c\u5f0f\u65e0\u6548"));
      }
    });

    req.on("error", reject);
  });
}

function receiveFileBody(req, targetPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(targetPath, { flags: "wx" });
    let bytes = 0;
    let settled = false;
    let pendingError = null;

    function finish(error) {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ bytes });
    }

    output.on("error", (error) => {
      pendingError = pendingError || error;
    });
    output.on("close", () => finish(pendingError));
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) return;
      const error = new Error("迁移包超过 2 GB 限制");
      error.statusCode = 413;
      pendingError = error;
      req.unpipe(output);
      req.resume();
      output.destroy();
    });
    req.on("error", (error) => {
      pendingError = pendingError || error;
      output.destroy();
    });
    req.on("aborted", () => {
      pendingError = pendingError || new Error("迁移包上传已中断");
      output.destroy();
    });
    req.pipe(output);
  });
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const decoded = decodeURIComponent(pathname);
  const target = path.resolve(PUBLIC_DIR, `.${decoded}`);

  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== PUBLIC_DIR) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(target, (error, data) => {
    if (error) {
      return sendText(res, 404, "Not found");
    }

    res.writeHead(200, {
      "Content-Type": getContentType(target),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendFileDownload(res, filePath, fileName, cleanup) {
  const stream = fs.createReadStream(filePath);
  let cleaned = false;
  const finish = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      cleanup?.();
    } catch {
      // The download has already completed; a later temp cleanup may retry.
    }
  };
  stream.on("error", (error) => {
    finish();
    if (!res.headersSent) sendError(res, 500, error.message);
    else res.destroy(error);
  });
  res.on("close", finish);
  res.on("finish", finish);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": fs.statSync(filePath).size,
    "Content-Disposition": `attachment; filename="${String(fileName || "project-workbench.plwmigrate").replace(/["\\\r\n]/g, "_")}"`,
    "Cache-Control": "no-store"
  });
  stream.pipe(res);
}

function sendError(res, statusCode, message, details = null) {
  sendJson(res, {
    ok: false,
    error: message,
    details
  }, statusCode);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(message);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[ext] || "application/octet-stream";
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url).catch((error) => sendError(res, 500, error.message));
      return;
    }
    serveStatic(req, res, url);
  });
}

const config = loadConfig();
const host = config.server.host || "127.0.0.1";
const port = Number(config.server.port || 3344);

createServer().listen(port, host, () => {
  console.log(`Project Launcher Workbench running at http://${host}:${port}`);
});
