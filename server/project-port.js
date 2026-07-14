function resolveProjectPort(project = {}) {
  const configuredPort = Number(project.port);
  if (Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535) {
    return configuredPort;
  }

  const rawUrl = String(project.url || "").trim();
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || !url.port) return null;

    const urlPort = Number(url.port);
    return Number.isInteger(urlPort) && urlPort >= 1 && urlPort <= 65535 ? urlPort : null;
  } catch {
    return null;
  }
}

module.exports = {
  resolveProjectPort
};
