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
const { checkProjectStatus } = require("./status-checker");
const { checkSystemHealth } = require("./system-health");
const { createCodexUsageService } = require("./codex-usage");

const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const runner = new ProjectRunner();
const codexUsageService = createCodexUsageService();

async function handleApi(req, res, url) {
  const config = loadConfig();
  const pathname = url.pathname;

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
    for (const project of config.projects) {
      const runtime = runner.getRuntimeState(project.id);
      statuses[project.id] = {
        ...(await checkProjectStatus(project, runtime)),
        runtime
      };
    }
    return sendJson(res, { statuses });
  }

  if (req.method === "GET" && pathname === "/api/system/health") {
    return sendJson(res, await checkSystemHealth(config.server));
  }

  if (pathname === "/api/codex/usage") {
    if (req.method !== "GET") return sendError(res, 405, "Method not allowed");
    return sendJson(res, await codexUsageService.getUsage());
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
      const projectStatus = await checkProjectStatus(project, runner.getRuntimeState(project.id));
      return sendJson(res, {
        id: project.id,
        status: projectStatus,
        runtime: runner.getRuntimeState(project.id)
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
      const result = await runner.startProject(project);
      return sendJson(res, result);
    }

    if (action === "stop") {
      const result = await runner.stopProject(project);
      return sendJson(res, result);
    }

    if (action === "restart") {
      const result = await runner.restartProject(project);
      return sendJson(res, result);
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
    return sendError(res, 400, error.message);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
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
