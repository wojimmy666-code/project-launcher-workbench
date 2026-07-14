class ProcessSnapshotCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.snapshot = null;
  }

  get(loader, options = {}) {
    const fresh = options.fresh === true;
    const now = Number.isFinite(options.now) ? options.now : Date.now();

    if (!fresh && this.snapshot && this.snapshot.expiresAt > now) {
      return this.snapshot.processes;
    }

    const processes = loader();
    if (!fresh) {
      this.snapshot = {
        processes,
        expiresAt: now + this.ttlMs
      };
    }
    return processes;
  }

  invalidate() {
    this.snapshot = null;
  }
}

module.exports = {
  ProcessSnapshotCache
};
