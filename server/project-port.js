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

function resolveProjectAuxiliaryPorts(project = {}) {
  const primaryPort = resolveProjectPort(project);
  const values = Array.isArray(project.auxiliaryPorts) ? project.auxiliaryPorts : [];
  return [...new Set(values
    .map(Number)
    .filter((port) => (
      Number.isInteger(port)
      && port >= 1
      && port <= 65535
      && port !== primaryPort
    )))]
    .sort((left, right) => left - right);
}

function resolveProjectPorts(project = {}) {
  const primaryPort = resolveProjectPort(project);
  return [...new Set([
    ...(Number.isInteger(primaryPort) ? [primaryPort] : []),
    ...resolveProjectAuxiliaryPorts(project)
  ])];
}

function getListeningInstancePorts(instance) {
  return [...new Set(
    (Array.isArray(instance?.ports) ? instance.ports : [instance?.port])
      .map(Number)
      .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
  )].sort((left, right) => left - right);
}

function partitionProjectListeningInstances(project = {}, instances = []) {
  const primaryPort = resolveProjectPort(project);
  const auxiliaryPortSet = new Set(resolveProjectAuxiliaryPorts(project));
  const targetInstances = [];
  const auxiliaryInstances = [];
  const alternateInstances = [];

  for (const instance of Array.isArray(instances) ? instances : []) {
    const ports = getListeningInstancePorts(instance);
    if (Number.isInteger(primaryPort) && ports.includes(primaryPort)) {
      targetInstances.push(instance);
    } else if (ports.length && ports.every((port) => auxiliaryPortSet.has(port))) {
      auxiliaryInstances.push(instance);
    } else {
      alternateInstances.push(instance);
    }
  }

  return { targetInstances, auxiliaryInstances, alternateInstances };
}

module.exports = {
  getListeningInstancePorts,
  partitionProjectListeningInstances,
  resolveProjectAuxiliaryPorts,
  resolveProjectPort,
  resolveProjectPorts
};
