const fs = require("node:fs");
const path = require("node:path");
const { CONFIG_PATH, ROOT_DIR, loadConfig } = require("./config");

const ALLOWED_TYPES = new Set(["exe", "bat", "cmd", "url", "folder", "file"]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const BACKUP_DIR = path.join(ROOT_DIR, "config", "backups");

function createProject(input) {
  const config = loadConfig();
  const project = normalizeProjectForSave(input);
  validateProject(project, config.projects);
  config.projects.push(project);
  const backupFile = writeConfig(config);
  return { project, projects: config.projects, backupFile };
}

function updateProject(currentId, input) {
  const config = loadConfig();
  const index = config.projects.findIndex((project) => project.id === currentId);
  if (index === -1) {
    throw new Error("项目不存在");
  }

  const project = normalizeProjectForSave(input);
  validateProject(project, config.projects, currentId);
  config.projects[index] = project;
  const backupFile = writeConfig(config);
  return { project, projects: config.projects, backupFile };
}

function deleteProject(id) {
  const config = loadConfig();
  const index = config.projects.findIndex((project) => project.id === id);
  if (index === -1) {
    throw new Error("项目不存在");
  }

  const [project] = config.projects.splice(index, 1);
  const backupFile = writeConfig(config);
  return { project, projects: config.projects, backupFile };
}

function reorderProjects(ids) {
  const config = loadConfig();
  const normalizedIds = Array.isArray(ids) ? ids.map(clean).filter(Boolean) : [];
  const existingIds = config.projects.map((project) => project.id);
  const existingSet = new Set(existingIds);
  const normalizedSet = new Set(normalizedIds);

  if (normalizedIds.length !== existingIds.length || normalizedSet.size !== normalizedIds.length) {
    throw new Error("\u9879\u76ee\u6392\u5e8f\u5217\u8868\u65e0\u6548");
  }

  const missing = existingIds.filter((id) => !normalizedSet.has(id));
  const unknown = normalizedIds.filter((id) => !existingSet.has(id));
  if (missing.length || unknown.length) {
    throw new Error("\u9879\u76ee\u6392\u5e8f\u5217\u8868\u4e0e\u5f53\u524d\u914d\u7f6e\u4e0d\u4e00\u81f4");
  }

  const projectsById = new Map(config.projects.map((project) => [project.id, project]));
  config.projects = normalizedIds.map((id) => projectsById.get(id));
  const backupFile = writeConfig(config);
  return { projects: config.projects, backupFile };
}

function validateProjectInput(input, currentId = null) {
  const config = loadConfig();
  const project = normalizeProjectForSave(input);
  validateProject(project, config.projects, currentId);
  return project;
}

function normalizeProjectForSave(input) {
  const project = {
    id: clean(input.id),
    name: clean(input.name),
    type: clean(input.type).toLowerCase(),
    category: clean(input.category) || "未分类",
    tags: normalizeTags(input.tags),
    favorite: Boolean(input.favorite),
    allowMultiple: Boolean(input.allowMultiple),
    detectExternal: input.detectExternal !== false,
    allowStopExternal: Boolean(input.allowStopExternal),
    dangerous: Boolean(input.dangerous),
    confirmBeforeStart: Boolean(input.confirmBeforeStart)
  };

  assignString(project, "path", input.path);
  assignString(project, "cwd", input.cwd);
  assignString(project, "command", input.command);
  assignString(project, "url", input.url);
  assignString(project, "host", input.host);
  assignString(project, "logFile", input.logFile);
  assignString(project, "codexCwd", input.codexCwd);

  if (input.port !== undefined && input.port !== null && clean(input.port) !== "") {
    project.port = Number(input.port);
  }

  const args = normalizeArgs(input.args);
  if (args.length) {
    project.args = args;
  }

  return project;
}

function validateProject(project, existingProjects, currentId = null) {
  const errors = [];

  if (!project.id) {
    errors.push("项目 ID 不能为空");
  } else if (!ID_PATTERN.test(project.id)) {
    errors.push("项目 ID 只能包含英文、数字、-、_");
  }

  if (!project.name) {
    errors.push("项目名称不能为空");
  }

  if (!ALLOWED_TYPES.has(project.type)) {
    errors.push("项目类型无效");
  }

  const duplicate = existingProjects.find((item) => item.id === project.id && item.id !== currentId);
  if (duplicate) {
    errors.push("项目 ID 已存在");
  }

  if (project.port !== undefined) {
    if (!Number.isInteger(project.port) || project.port < 1 || project.port > 65535) {
      errors.push("端口必须是 1-65535 的整数");
    }
  }

  if (project.url !== undefined) {
    try {
      const url = new URL(project.url);
      if (!["http:", "https:"].includes(url.protocol)) {
        errors.push("网址只支持 http 或 https");
      }
    } catch {
      errors.push("网址格式无效");
    }
  }

  if (project.cwd !== undefined) {
    validateExistingPath(project.cwd, "工作目录", errors, "directory");
  }

  if (project.codexCwd !== undefined) {
    validateExistingPath(project.codexCwd, "Codex 项目目录", errors, "directory");
  }

  if (["exe", "bat", "file", "folder"].includes(project.type)) {
    if (!project.path) {
      errors.push("当前类型必须填写路径");
    } else {
      validateExistingPath(project.path, "路径", errors, project.type === "folder" ? "directory" : "file");
    }
  }

  if (project.type === "cmd") {
    if (!project.command) {
      errors.push("命令类型必须填写启动命令");
    }
    if (!project.cwd) {
      errors.push("命令类型必须填写工作目录");
    }
  }

  if (project.type === "url" && !project.url) {
    errors.push("网页类型必须填写网址");
  }

  if (project.logFile && path.isAbsolute(project.logFile)) {
    errors.push("日志文件请使用相对路径，例如 logs\\demo.log");
  }

  if (errors.length) {
    const error = new Error(errors.join("；"));
    error.details = errors;
    throw error;
  }
}

function validateExistingPath(value, label, errors, expectedType) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    errors.push(`${label}不存在`);
    return;
  }

  const stats = fs.statSync(resolved);
  if (expectedType === "directory" && !stats.isDirectory()) {
    errors.push(`${label}必须是目录`);
  }
  if (expectedType === "file" && !stats.isFile()) {
    errors.push(`${label}必须是文件`);
  }
}

function writeConfig(config) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `projects.${timestamp()}.json`);
  fs.copyFileSync(CONFIG_PATH, backupFile);

  const tempFile = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, CONFIG_PATH);
  return path.relative(ROOT_DIR, backupFile);
}

function assignString(target, key, value) {
  const cleaned = clean(value);
  if (cleaned) {
    target[key] = cleaned;
  }
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map(clean).filter(Boolean);
  }

  return clean(value)
    .split(/[,\n，]/)
    .map(clean)
    .filter(Boolean);
}

function normalizeArgs(value) {
  if (Array.isArray(value)) {
    return value.map(clean).filter(Boolean);
  }

  return clean(value)
    .split(/\n/)
    .map(clean)
    .filter(Boolean);
}

function clean(value) {
  return String(value ?? "").trim();
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

module.exports = {
  createProject,
  deleteProject,
  normalizeProjectForSave,
  reorderProjects,
  updateProject,
  validateProjectInput
};
