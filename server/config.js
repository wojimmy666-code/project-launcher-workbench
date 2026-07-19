const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config", "projects.json");
const LOGS_DIR = path.join(ROOT_DIR, "logs");

const UNCATEGORIZED_CATEGORY_ID = "uncategorized";
const UNCATEGORIZED_CATEGORY_NAME = "\u672a\u5206\u7c7b";
const RESERVED_CATEGORY_IDS = new Set(["all", "running", "favorite", UNCATEGORIZED_CATEGORY_ID]);
const CATEGORY_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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
  health: {
    externalConnectivity: {
      mode: "auto",
      proxy: null,
      targets: [
        "https://www.google.com/generate_204",
        "https://www.gstatic.com/generate_204"
      ],
      browserProbeUrl: "https://www.google.com/generate_204"
    }
  },
  categories: [],
  projects: []
};

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const rawProjects = Array.isArray(parsed.projects) ? parsed.projects : [];
  const categories = normalizeCategories(parsed.categories, rawProjects);
  const categoryMap = createCategoryLookup(categories);
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
    health: {
      ...DEFAULT_CONFIG.health,
      ...(parsed.health || {}),
      externalConnectivity: {
        ...DEFAULT_CONFIG.health.externalConnectivity,
        ...(parsed.health?.externalConnectivity || {})
      }
    },
    categories,
    projects: rawProjects.map((project) => normalizeProject(project, categoryMap))
  };

  assertUniqueProjectIds(config.projects);
  return config;
}

function normalizeCategories(input, projects = []) {
  const usedIds = new Set();
  const categories = [];
  const sourceCategories = Array.isArray(input) ? input : [];

  for (const item of sourceCategories) {
    const category = normalizeCategory(item, categories.length, usedIds);
    if (category) {
      categories.push(category);
    }
  }

  const names = new Set(categories.map((category) => normalizeCategoryName(category.name)));
  const ids = new Set(categories.map((category) => category.id));
  for (const project of projects) {
    const rawCategory = String(project?.category || "").trim();
    if (isUncategorizedCategory(rawCategory)) continue;
    const normalizedName = normalizeCategoryName(rawCategory);
    if (!rawCategory || ids.has(rawCategory) || names.has(normalizedName)) continue;

    const category = normalizeCategory({ name: rawCategory }, categories.length, usedIds);
    if (category) {
      categories.push(category);
      names.add(normalizeCategoryName(category.name));
      ids.add(category.id);
    }
  }

  return sortCategories(categories);
}

function normalizeCategory(input, index, usedIds) {
  const rawName = String(input?.name || input?.id || "").trim();
  if (!rawName || isUncategorizedCategory(rawName)) {
    return null;
  }

  let id = String(input?.id || "").trim();
  if (!isValidCustomCategoryId(id) || usedIds.has(id)) {
    id = uniqueCategoryId(slugCategoryName(rawName), usedIds);
  }

  usedIds.add(id);
  const order = Number.isFinite(Number(input?.order)) ? Number(input.order) : index;
  return {
    id,
    name: rawName,
    order
  };
}

function sortCategories(categories) {
  return [...categories].sort((a, b) => {
    const orderDelta = Number(a.order || 0) - Number(b.order || 0);
    if (orderDelta) return orderDelta;
    return a.name.localeCompare(b.name, "zh-CN");
  }).map((category, index) => ({
    ...category,
    order: index
  }));
}

function createCategoryLookup(categories) {
  const ids = new Set(categories.map((category) => category.id));
  const names = new Map(categories.map((category) => [normalizeCategoryName(category.name), category.id]));
  return { ids, names };
}

function normalizeProject(project, categoryMap = createCategoryLookup([])) {
  return {
    ...project,
    id: String(project.id || "").trim(),
    name: String(project.name || project.id || "").trim(),
    type: String(project.type || "").trim().toLowerCase(),
    category: normalizeProjectCategory(project.category, categoryMap),
    tags: Array.isArray(project.tags) ? project.tags.map(String) : [],
    processMatch: normalizeStringList(project.processMatch),
    favorite: Boolean(project.favorite),
    allowMultiple: Boolean(project.allowMultiple),
    hideConsole: Boolean(project.hideConsole),
    detectExternal: project.detectExternal !== false,
    allowStopExternal: Boolean(project.allowStopExternal),
    dangerous: Boolean(project.dangerous),
    confirmBeforeStart: Boolean(project.confirmBeforeStart)
  };
}

function normalizeStringList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeProjectCategory(value, categoryMap = createCategoryLookup([])) {
  const raw = String(value || "").trim();
  if (isUncategorizedCategory(raw)) {
    return UNCATEGORIZED_CATEGORY_ID;
  }
  if (categoryMap.ids.has(raw)) {
    return raw;
  }

  const categoryId = categoryMap.names.get(normalizeCategoryName(raw));
  return categoryId || UNCATEGORIZED_CATEGORY_ID;
}

function isUncategorizedCategory(value) {
  const raw = String(value || "").trim();
  return !raw || raw === UNCATEGORIZED_CATEGORY_ID || raw === UNCATEGORIZED_CATEGORY_NAME;
}

function isValidCustomCategoryId(value) {
  const id = String(value || "").trim();
  return CATEGORY_ID_PATTERN.test(id) && !RESERVED_CATEGORY_IDS.has(id);
}

function uniqueCategoryId(base, usedIds) {
  const safeBase = isValidCustomCategoryId(base) ? base : "category";
  let id = safeBase;
  let index = 1;
  while (usedIds.has(id) || RESERVED_CATEGORY_IDS.has(id)) {
    id = `${safeBase}-${index}`;
    index += 1;
  }
  return id;
}

function slugCategoryName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "category";
}

function normalizeCategoryName(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
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
  CATEGORY_ID_PATTERN,
  CONFIG_PATH,
  LOGS_DIR,
  RESERVED_CATEGORY_IDS,
  ROOT_DIR,
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
  createCategoryLookup,
  findProject,
  isUncategorizedCategory,
  isValidCustomCategoryId,
  loadConfig,
  normalizeCategoryName,
  normalizeProjectCategory,
  resolveLogFile,
  slugCategoryName,
  sortCategories
};
