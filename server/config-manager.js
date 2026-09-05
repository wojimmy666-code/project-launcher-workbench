const fs = require("node:fs");
const path = require("node:path");
const { resolveProjectPorts } = require("./project-port");
const {
  CONFIG_PATH,
  ROOT_DIR,
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
  isUncategorizedCategory,
  isValidCustomCategoryId,
  loadConfig,
  normalizeCategoryName,
  normalizeProcessMatchGroups,
  slugCategoryName,
  sortCategories
} = require("./config");

const ALLOWED_TYPES = new Set(["exe", "bat", "cmd", "url", "folder", "file"]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const BACKUP_DIR = path.join(ROOT_DIR, "config", "backups");

function createProject(input) {
  const config = loadConfig();
  const project = normalizeProjectForSave(input, config.categories);
  validateProject(project, config.projects, null, config.categories);
  config.projects.push(project);
  const backupFile = writeConfig(config);
  return { project, projects: config.projects, categories: config.categories, backupFile };
}

function updateProject(currentId, input) {
  const config = loadConfig();
  const index = config.projects.findIndex((project) => project.id === currentId);
  if (index === -1) {
    throw new Error("\u9879\u76ee\u4e0d\u5b58\u5728");
  }

  const project = normalizeProjectForSave(input, config.categories);
  validateProject(project, config.projects, currentId, config.categories);
  config.projects[index] = project;
  const backupFile = writeConfig(config);
  return { project, projects: config.projects, categories: config.categories, backupFile };
}

function deleteProject(id) {
  const config = loadConfig();
  const index = config.projects.findIndex((project) => project.id === id);
  if (index === -1) {
    throw new Error("\u9879\u76ee\u4e0d\u5b58\u5728");
  }

  const [project] = config.projects.splice(index, 1);
  const backupFile = writeConfig(config);
  return { project, projects: config.projects, categories: config.categories, backupFile };
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
  return { projects: config.projects, categories: config.categories, backupFile };
}

function createCategory(input) {
  const config = loadConfig();
  const category = normalizeCategoryForSave(input, config.categories);
  validateCategory(category, config.categories);
  config.categories = sortCategories([...config.categories, category]);
  const backupFile = writeConfig(config);
  return { category, categories: config.categories, projects: config.projects, backupFile };
}

function updateCategory(id, input) {
  const config = loadConfig();
  const categoryId = clean(id);
  assertEditableCategoryId(categoryId);
  const index = config.categories.findIndex((category) => category.id === categoryId);
  if (index === -1) {
    throw new Error("\u5206\u7c7b\u4e0d\u5b58\u5728");
  }

  const category = {
    ...config.categories[index],
    name: clean(input.name)
  };
  validateCategory(category, config.categories, categoryId);
  config.categories[index] = category;
  config.categories = sortCategories(config.categories);
  const backupFile = writeConfig(config);
  return { category, categories: config.categories, projects: config.projects, backupFile };
}

function deleteCategory(id) {
  const config = loadConfig();
  const categoryId = clean(id);
  assertEditableCategoryId(categoryId);
  const index = config.categories.findIndex((category) => category.id === categoryId);
  if (index === -1) {
    throw new Error("\u5206\u7c7b\u4e0d\u5b58\u5728");
  }

  const [category] = config.categories.splice(index, 1);
  config.categories = sortCategories(config.categories);
  config.projects = config.projects.map((project) => (
    project.category === categoryId ? { ...project, category: UNCATEGORIZED_CATEGORY_ID } : project
  ));
  const backupFile = writeConfig(config);
  return { category, categories: config.categories, projects: config.projects, backupFile };
}

function reorderCategories(ids) {
  const config = loadConfig();
  const normalizedIds = Array.isArray(ids) ? ids.map(clean).filter(Boolean) : [];
  const existingIds = config.categories.map((category) => category.id);
  const existingSet = new Set(existingIds);
  const normalizedSet = new Set(normalizedIds);

  if (normalizedIds.length !== existingIds.length || normalizedSet.size !== normalizedIds.length) {
    throw new Error("\u5206\u7c7b\u6392\u5e8f\u5217\u8868\u65e0\u6548");
  }

  const missing = existingIds.filter((id) => !normalizedSet.has(id));
  const unknown = normalizedIds.filter((id) => !existingSet.has(id));
  if (missing.length || unknown.length) {
    throw new Error("\u5206\u7c7b\u6392\u5e8f\u5217\u8868\u4e0e\u5f53\u524d\u914d\u7f6e\u4e0d\u4e00\u81f4");
  }

  const categoriesById = new Map(config.categories.map((category) => [category.id, category]));
  config.categories = normalizedIds.map((id, index) => ({ ...categoriesById.get(id), order: index }));
  const backupFile = writeConfig(config);
  return { categories: config.categories, projects: config.projects, backupFile };
}

function validateProjectInput(input, currentId = null) {
  const config = loadConfig();
  const project = normalizeProjectForSave(input, config.categories);
  validateProject(project, config.projects, currentId, config.categories);
  return project;
}

function normalizeProjectForSave(input, categories = []) {
  const hideLauncherConsole = input.hideLauncherConsole === undefined
    ? Boolean(input.hideConsole)
    : Boolean(input.hideLauncherConsole);
  const allowInteractiveConsole = input.allowInteractiveConsole === undefined
    ? Boolean(input.allowChildConsole)
    : Boolean(input.allowInteractiveConsole);
  const project = {
    id: clean(input.id),
    name: clean(input.name),
    type: clean(input.type).toLowerCase(),
    category: normalizeCategoryInput(input.category, categories),
    tags: normalizeTags(input.tags),
    favorite: Boolean(input.favorite),
    allowMultiple: Boolean(input.allowMultiple),
    launchMode: ["foreground", "detached"].includes(clean(input.launchMode).toLowerCase())
      ? clean(input.launchMode).toLowerCase()
      : "foreground",
    hideLauncherConsole,
    showServiceConsoles: input.showServiceConsoles !== false,
    allowInteractiveConsole,
    // Keep the old keys synchronized during the compatibility window.
    hideConsole: hideLauncherConsole,
    allowChildConsole: allowInteractiveConsole,
    detectExternal: input.detectExternal !== false,
    allowStopExternal: Boolean(input.allowStopExternal),
    dangerous: Boolean(input.dangerous),
    confirmBeforeStart: Boolean(input.confirmBeforeStart)
  };

  const externalControl = normalizeExternalControl(input.externalControl);
  if (externalControl) project.externalControl = externalControl;

  assignString(project, "path", input.path);
  assignString(project, "cwd", input.cwd);
  assignString(project, "command", input.command);
  assignString(project, "url", input.url);
  assignString(project, "host", input.host);
  assignString(project, "logFile", input.logFile);
  assignString(project, "codexCwd", input.codexCwd);
  assignGithubUrl(project, input.githubUrl);

  if (input.port !== undefined && input.port !== null && clean(input.port) !== "") {
    project.port = Number(input.port);
  }

  if (input.startupTimeoutMs !== undefined && input.startupTimeoutMs !== null && clean(input.startupTimeoutMs) !== "") {
    project.startupTimeoutMs = Number(input.startupTimeoutMs);
  }

  const auxiliaryPorts = normalizePortList(input.auxiliaryPorts);
  if (auxiliaryPorts.length) {
    project.auxiliaryPorts = auxiliaryPorts;
  }

  const args = normalizeArgs(input.args);
  if (args.length) {
    project.args = args;
  }

  const processMatch = normalizeProcessMatch(input.processMatch);
  if (processMatch.length) {
    project.processMatch = processMatch;
  }
  const processMatchGroups = normalizeProcessMatchGroups(input.processMatchGroups);
  if (processMatchGroups.length) project.processMatchGroups = processMatchGroups;

  return project;
}

function normalizeExternalControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const command = clean(value.command);
  if (!command) return null;
  const actions = {};
  for (const name of [
    "prepareManagedStart",
    "managedStarted",
    "managedStartFailed",
    "prepareManagedStop",
    "stopExternal",
    "prepareAdopt"
  ]) {
    const args = normalizeArgs(value.actions?.[name]);
    if (args.length) actions[name] = args;
  }
  const timeoutMs = Number(value.timeoutMs);
  return {
    command,
    args: normalizeArgs(value.args),
    cwd: clean(value.cwd),
    stateFile: clean(value.stateFile),
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000
      ? timeoutMs
      : 15000,
    actions
  };
}

function normalizeCategoryForSave(input, existingCategories) {
  const name = clean(input.name);
  const requestedId = clean(input.id);
  const id = requestedId || makeUniqueCategoryId(slugCategoryName(name), existingCategories);
  const maxOrder = existingCategories.reduce((max, category) => Math.max(max, Number(category.order || 0)), -1);
  return {
    id,
    name,
    order: maxOrder + 1
  };
}

function normalizeCategoryInput(value, categories) {
  const raw = clean(value);
  if (isUncategorizedCategory(raw)) {
    return UNCATEGORIZED_CATEGORY_ID;
  }

  const exact = categories.find((category) => category.id === raw);
  if (exact) {
    return exact.id;
  }

  const normalizedName = normalizeCategoryName(raw);
  const named = categories.find((category) => normalizeCategoryName(category.name) === normalizedName);
  return named?.id || UNCATEGORIZED_CATEGORY_ID;
}

function validateProject(project, existingProjects, currentId = null, categories = []) {
  const errors = [];

  if (!project.id) {
    errors.push("\u9879\u76ee ID \u4e0d\u80fd\u4e3a\u7a7a");
  } else if (!ID_PATTERN.test(project.id)) {
    errors.push("\u9879\u76ee ID \u53ea\u80fd\u5305\u542b\u82f1\u6587\u3001\u6570\u5b57\u3001- \u548c _");
  }

  if (!project.name) {
    errors.push("\u9879\u76ee\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a");
  }

  if (!ALLOWED_TYPES.has(project.type)) {
    errors.push("\u9879\u76ee\u7c7b\u578b\u65e0\u6548");
  }

  const duplicate = existingProjects.find((item) => item.id === project.id && item.id !== currentId);
  if (duplicate) {
    errors.push("\u9879\u76ee ID \u5df2\u5b58\u5728");
  }

  const categoryIds = new Set(categories.map((category) => category.id));
  if (project.category !== UNCATEGORIZED_CATEGORY_ID && !categoryIds.has(project.category)) {
    errors.push("\u5206\u7c7b\u4e0d\u5b58\u5728");
  }

  if (project.port !== undefined) {
    if (!Number.isInteger(project.port) || project.port < 1 || project.port > 65535) {
      errors.push("\u7aef\u53e3\u5fc5\u987b\u662f 1-65535 \u7684\u6574\u6570");
    }
  }

  if (!["foreground", "detached"].includes(project.launchMode || "foreground")) {
    errors.push("启动生命周期必须是前台常驻或派生服务");
  }

  if (project.startupTimeoutMs !== undefined) {
    if (!Number.isInteger(project.startupTimeoutMs) || project.startupTimeoutMs < 1000 || project.startupTimeoutMs > 600000) {
      errors.push("启动确认超时必须是 1000-600000 毫秒的整数");
    }
  }

  if (Array.isArray(project.auxiliaryPorts)) {
    if (project.auxiliaryPorts.length > 8) {
      errors.push("\u8f85\u52a9\u7aef\u53e3\u6700\u591a 8 \u4e2a");
    }
    for (const port of project.auxiliaryPorts) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push("\u8f85\u52a9\u7aef\u53e3\u5fc5\u987b\u662f 1-65535 \u7684\u6574\u6570");
        break;
      }
    }
    if (Number.isInteger(project.port) && project.auxiliaryPorts.includes(project.port)) {
      errors.push("\u8f85\u52a9\u7aef\u53e3\u4e0d\u80fd\u4e0e\u4e3b\u7aef\u53e3\u76f8\u540c");
    }
  }

  if (Array.isArray(project.processMatchGroups) && project.processMatchGroups.length > 8) {
    errors.push("额外进程匹配组最多 8 组");
  }
  for (const group of [project.processMatch, ...(project.processMatchGroups || [])].filter(Array.isArray)) {
    if (group.length > 8) {
      errors.push("进程匹配特征最多 8 条");
    }
    for (const matcher of group) {
      if (matcher.length < 3 || matcher.length > 200) {
        errors.push("进程匹配特征长度必须为 3-200 个字符");
        break;
      }
    }
  }

  if (project.externalControl) {
    if (!path.isAbsolute(project.externalControl.command)) {
      errors.push("外部控制命令必须使用绝对路径");
    }
    if (project.externalControl.cwd && !path.isAbsolute(project.externalControl.cwd)) {
      errors.push("外部控制工作目录必须使用绝对路径");
    }
    if (project.externalControl.stateFile && !isAbsoluteExternalControlStatePath(project.externalControl.stateFile)) {
      errors.push("外部控制状态文件必须使用绝对路径");
    }
    const actionEntries = Object.entries(project.externalControl.actions || {});
    for (const [name, args] of actionEntries) {
      if (!Array.isArray(args) || args.length > 32 || args.some((arg) => arg.length > 1000)) {
        errors.push(`外部控制动作 ${name} 的参数无效`);
        break;
      }
    }
  }

  const projectPorts = resolveProjectPorts(project);
  if (projectPorts.length && ["exe", "bat", "cmd"].includes(project.type)) {
    for (const configuredPort of projectPorts) {
      const duplicatePort = existingProjects.find((item) => (
        item.id !== currentId
        && ["exe", "bat", "cmd"].includes(item.type)
        && resolveProjectPorts(item).includes(configuredPort)
      ));
      if (duplicatePort) {
        errors.push(`\u7aef\u53e3 ${configuredPort} \u5df2\u7531\u9879\u76ee\u300c${duplicatePort.name}\u300d\u4f7f\u7528`);
      }
    }
  }
  if (project.url !== undefined) {
    try {
      const url = new URL(project.url);
      if (!["http:", "https:"].includes(url.protocol)) {
        errors.push("\u7f51\u5740\u53ea\u652f\u6301 http \u6216 https");
      }
    } catch {
      errors.push("\u7f51\u5740\u683c\u5f0f\u65e0\u6548");
    }
  }

  if (project.githubUrl !== undefined) {
    try {
      const url = new URL(project.githubUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        errors.push("GitHub \u5730\u5740\u53ea\u652f\u6301 http \u6216 https");
      }
      if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
        errors.push("GitHub \u5730\u5740\u5fc5\u987b\u662f github.com \u57df\u540d");
      }
    } catch {
      errors.push("GitHub \u5730\u5740\u683c\u5f0f\u65e0\u6548");
    }
  }

  if (project.cwd !== undefined) {
    validateExistingPath(project.cwd, "\u5de5\u4f5c\u76ee\u5f55", errors, "directory");
  }

  if (project.codexCwd !== undefined) {
    validateExistingPath(project.codexCwd, "Codex \u9879\u76ee\u76ee\u5f55", errors, "directory");
  }

  if (["exe", "bat", "file", "folder"].includes(project.type)) {
    if (!project.path) {
      errors.push("\u5f53\u524d\u7c7b\u578b\u5fc5\u987b\u586b\u5199\u8def\u5f84");
    } else {
      validateExistingPath(project.path, "\u8def\u5f84", errors, project.type === "folder" ? "directory" : "file");
    }
  }

  if (project.type === "cmd") {
    if (!project.command) {
      errors.push("\u547d\u4ee4\u7c7b\u578b\u5fc5\u987b\u586b\u5199\u542f\u52a8\u547d\u4ee4");
    }
    if (!project.cwd) {
      errors.push("\u547d\u4ee4\u7c7b\u578b\u5fc5\u987b\u586b\u5199\u5de5\u4f5c\u76ee\u5f55");
    }
  }

  if (project.type === "url" && !project.url) {
    errors.push("\u7f51\u9875\u7c7b\u578b\u5fc5\u987b\u586b\u5199\u7f51\u5740");
  }

  if (project.logFile && path.isAbsolute(project.logFile)) {
    errors.push("\u65e5\u5fd7\u6587\u4ef6\u8bf7\u4f7f\u7528\u76f8\u5bf9\u8def\u5f84\uff0c\u4f8b\u5982 logs\\demo.log");
  }

  if (errors.length) {
    const error = new Error(errors.join("\uff1b"));
    error.details = errors;
    throw error;
  }
}

function validateCategory(category, existingCategories, currentId = null) {
  const errors = [];
  const normalizedName = normalizeCategoryName(category.name);

  if (!category.name) {
    errors.push("\u5206\u7c7b\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a");
  } else if (category.name.length > 40) {
    errors.push("\u5206\u7c7b\u540d\u79f0\u4e0d\u80fd\u8d85\u8fc7 40 \u4e2a\u5b57\u7b26");
  }

  if (isUncategorizedCategory(category.name)) {
    errors.push(`${UNCATEGORIZED_CATEGORY_NAME} \u662f\u7cfb\u7edf\u5206\u7c7b`);
  }

  if (!isValidCustomCategoryId(category.id)) {
    errors.push("\u5206\u7c7b ID \u65e0\u6548");
  }

  const duplicateId = existingCategories.find((item) => item.id === category.id && item.id !== currentId);
  if (duplicateId) {
    errors.push("\u5206\u7c7b ID \u5df2\u5b58\u5728");
  }

  const duplicateName = existingCategories.find((item) => (
    item.id !== currentId && normalizeCategoryName(item.name) === normalizedName
  ));
  if (duplicateName) {
    errors.push("\u5206\u7c7b\u540d\u79f0\u5df2\u5b58\u5728");
  }

  if (errors.length) {
    const error = new Error(errors.join("\uff1b"));
    error.details = errors;
    throw error;
  }
}

function assertEditableCategoryId(id) {
  if (!id || isUncategorizedCategory(id) || ["all", "running", "favorite"].includes(id)) {
    throw new Error("\u7cfb\u7edf\u5206\u7c7b\u4e0d\u80fd\u7f16\u8f91");
  }
}

function makeUniqueCategoryId(base, categories) {
  const usedIds = new Set(categories.map((category) => category.id));
  const safeBase = isValidCustomCategoryId(base) ? base : "category";
  let id = safeBase;
  let index = 1;
  while (usedIds.has(id)) {
    id = `${safeBase}-${index}`;
    index += 1;
  }
  return id;
}

function validateExistingPath(value, label, errors, expectedType) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    errors.push(`${label}\u4e0d\u5b58\u5728`);
    return;
  }

  const stats = fs.statSync(resolved);
  if (expectedType === "directory" && !stats.isDirectory()) {
    errors.push(`${label}\u5fc5\u987b\u662f\u76ee\u5f55`);
  }
  if (expectedType === "file" && !stats.isFile()) {
    errors.push(`${label}\u5fc5\u987b\u662f\u6587\u4ef6`);
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

function replaceConfigSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("导入配置必须是对象");
  }
  if (!Array.isArray(input.projects) || !Array.isArray(input.categories)) {
    throw new Error("导入配置缺少项目或分类列表");
  }

  const snapshot = JSON.parse(JSON.stringify(input));
  const backupFile = writeConfig(snapshot);
  try {
    const config = loadConfig();
    return {
      config,
      projects: config.projects,
      categories: config.categories,
      backupFile
    };
  } catch (error) {
    fs.copyFileSync(path.join(ROOT_DIR, backupFile), CONFIG_PATH);
    throw error;
  }
}

function isAbsoluteExternalControlStatePath(value) {
  const text = clean(value);
  return path.isAbsolute(text) || /^%LOCALAPPDATA%[\\/]/i.test(text);
}

function assignString(target, key, value) {
  const cleaned = clean(value);
  if (cleaned) {
    target[key] = cleaned;
  }
}

function assignGithubUrl(target, value) {
  const normalized = normalizeGithubUrl(value);
  if (normalized) {
    target.githubUrl = normalized;
  }
}

function normalizeGithubUrl(value) {
  const raw = clean(value);
  if (!raw) return "";

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`;
  }

  return raw;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map(clean).filter(Boolean);
  }

  return clean(value)
    .split(/[,\n\uFF0C]/)
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

function normalizeProcessMatch(value) {
  const items = Array.isArray(value) ? value : clean(value).split(/\r?\n/);
  return [...new Set(items.map(clean).filter(Boolean))];
}

function normalizePortList(value) {
  const items = Array.isArray(value)
    ? value
    : clean(value).split(/[\s,\uFF0C]+/);
  return [...new Set(items.map(clean).filter(Boolean).map(Number))];
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
  createCategory,
  createProject,
  deleteCategory,
  deleteProject,
  normalizeProjectForSave,
  replaceConfigSnapshot,
  reorderCategories,
  reorderProjects,
  updateCategory,
  updateProject,
  validateProject,
  validateProjectInput
};
