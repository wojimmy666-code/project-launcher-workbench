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

  peek(options = {}) {
    if (!this.snapshot) return null;
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (options.allowStale === true || this.snapshot.expiresAt > now) {
      return this.snapshot.processes;
    }
    return null;
  }

  isFresh(now = Date.now()) {
    return Boolean(this.snapshot && this.snapshot.expiresAt > now);
  }

  set(processes, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    this.snapshot = {
      processes,
      expiresAt: now + this.ttlMs
    };
    return processes;
  }

  invalidate() {
    if (this.snapshot) {
      this.snapshot.expiresAt = 0;
    }
  }
}

module.exports = {
  ProcessSnapshotCache
};
