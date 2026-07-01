const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config", "projects.json");
const LOGS_DIR = path.join(ROOT_DIR, "logs");

const DEFAULT_CONFIG = {
  server: {
    host: "127.0.0.1",
    port: 3344
  },
  security: {
    allowOnlyConfiguredProjects: true,
    confirmDangerousActions: true,
    allowNetworkAccess: false
  },
  projects: []
};

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    server: {
      ...DEFAULT_CONFIG.server,
      ...(parsed.server || {})
    },
    security: {
      ...DEFAULT_CONFIG.security,
      ...(parsed.security || {})
    },
    projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeProject) : []
  };

  assertUniqueProjectIds(config.projects);
  return config;
}

function normalizeProject(project) {
  return {
    ...project,
    id: String(project.id || "").trim(),
    name: String(project.name || project.id || "").trim(),
    type: String(project.type || "").trim().toLowerCase(),
    category: String(project.category || "未分类").trim(),
    tags: Array.isArray(project.tags) ? project.tags.map(String) : [],
    favorite: Boolean(project.favorite),
    allowMultiple: Boolean(project.allowMultiple),
    detectExternal: project.detectExternal !== false,
    allowStopExternal: Boolean(project.allowStopExternal),
    dangerous: Boolean(project.dangerous),
    confirmBeforeStart: Boolean(project.confirmBeforeStart)
  };
}

function assertUniqueProjectIds(projects) {
  const ids = new Set();
  for (const project of projects) {
    if (!project.id) {
      throw new Error("projects.json contains a project without id");
    }
    if (ids.has(project.id)) {
      throw new Error(`Duplicate project id: ${project.id}`);
    }
    ids.add(project.id);
  }
}

function findProject(config, id) {
  return config.projects.find((project) => project.id === id) || null;
}

function resolveLogFile(project) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const fallbackName = `${safeFilePart(project.id || "project")}.log`;
  const rawLogFile = project.logFile || path.join("logs", fallbackName);
  const resolved = path.resolve(ROOT_DIR, rawLogFile);
  const logsRoot = path.resolve(LOGS_DIR);

  if (resolved === logsRoot || resolved.startsWith(`${logsRoot}${path.sep}`)) {
    return resolved;
  }

  return path.join(LOGS_DIR, fallbackName);
}

function safeFilePart(value) {
  return String(value).replace(/[^a-z0-9._-]/gi, "_");
}

module.exports = {
  CONFIG_PATH,
  LOGS_DIR,
  ROOT_DIR,
  findProject,
  loadConfig,
  resolveLogFile
};
