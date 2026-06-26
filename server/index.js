const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { findProject, loadConfig, ROOT_DIR } = require("./config");
const { ProjectRunner } = require("./project-runner");
const { checkProjectStatus } = require("./status-checker");

const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const runner = new ProjectRunner();

async function handleApi(req, res, url) {
  const config = loadConfig();
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/projects") {
    return sendJson(res, {
      projects: config.projects,
      server: config.server,
      security: config.security
    });
  }

  if (req.method === "GET" && pathname === "/api/status/all") {
    const statuses = {};
    await Promise.all(config.projects.map(async (project) => {
      const runtime = runner.getRuntimeState(project.id);
      statuses[project.id] = {
        ...(await checkProjectStatus(project, runtime)),
        runtime
      };
    }));
    return sendJson(res, { statuses });
  }

  const match = pathname.match(/^\/api\/projects\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return sendError(res, 404, "API not found");
  }

  const projectId = decodeURIComponent(match[1]);
  const action = match[2];
  const project = findProject(config, projectId);
  if (!project) {
    return sendError(res, 404, "项目不存在");
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
        return sendError(res, 400, "项目未配置 url");
      }
      const result = await runner.openProject({ ...project, type: "url" });
      return sendJson(res, result);
    }

    if (action === "open-folder") {
      const result = await runner.openFolder(project);
      return sendJson(res, result);
    }

    return sendError(res, 404, "API action not found");
  } catch (error) {
    return sendError(res, 400, error.message);
  }
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

function sendError(res, statusCode, message) {
  sendJson(res, {
    ok: false,
    error: message
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
