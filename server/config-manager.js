const fs = require("node:fs");
const path = require("node:path");
const { resolveProjectPort } = require("./project-port");
const {
  CONFIG_PATH,
  ROOT_DIR,
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
  isUncategorizedCategory,
  isValidCustomCategoryId,
  loadConfig,
  normalizeCategoryName,
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
  const project = {
    id: clean(input.id),
    name: clean(input.name),
    type: clean(input.type).toLowerCase(),
    category: normalizeCategoryInput(input.category, categories),
    tags: normalizeTags(input.tags),
    favorite: Boolean(input.favorite),
    allowMultiple: Boolean(input.allowMultiple),
    hideConsole: Boolean(input.hideConsole),
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
  assignGithubUrl(project, input.githubUrl);

  if (input.port !== undefined && input.port !== null && clean(input.port) !== "") {
    project.port = Number(input.port);
  }

  const args = normalizeArgs(input.args);
  if (args.length) {
    project.args = args;
  }

  const processMatch = normalizeProcessMatch(input.processMatch);
  if (processMatch.length) {
    project.processMatch = processMatch;
  }

  return project;
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

  if (Array.isArray(project.processMatch)) {
    if (project.processMatch.length > 8) {
      errors.push("进程匹配特征最多 8 条");
    }
    for (const matcher of project.processMatch) {
      if (matcher.length < 3 || matcher.length > 200) {
        errors.push("进程匹配特征长度必须为 3-200 个字符");
        break;
      }
    }
  }

  const projectPort = resolveProjectPort(project);
  if (Number.isInteger(projectPort) && ["exe", "bat", "cmd"].includes(project.type)) {
    const duplicatePort = existingProjects.find((item) => (
      item.id !== currentId
      && ["exe", "bat", "cmd"].includes(item.type)
      && resolveProjectPort(item) === projectPort
    ));
    if (duplicatePort) {
      errors.push(`\u7aef\u53e3 ${projectPort} \u5df2\u7531\u9879\u76ee\u300c${duplicatePort.name}\u300d\u4f7f\u7528`);
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
  reorderCategories,
  reorderProjects,
  updateCategory,
  updateProject,
  validateProject,
  validateProjectInput
};
