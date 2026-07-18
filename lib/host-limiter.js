export class HostLimiter {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.hosts = new Map();
  }

  acquire(host, signal) {
    const key = String(host || "unknown").toLowerCase();
    const state = this.hosts.get(key) || { active: 0, queue: [] };
    this.hosts.set(key, state);

    if (state.active < this.limit) {
      state.active += 1;
      return Promise.resolve(() => this.release(key));
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      state.queue.push(waiter);
      const abort = () => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
      };
      waiter.abort = abort;
      signal?.addEventListener("abort", abort, { once: true });
    }).then(() => () => this.release(key));
  }

  release(key) {
    const state = this.hosts.get(key);
    if (!state) return;
    const next = state.queue.shift();
    if (next) {
      next.abort && next.signal?.removeEventListener?.("abort", next.abort);
      next.resolve();
      return;
    }
    state.active = Math.max(0, state.active - 1);
    if (state.active === 0) this.hosts.delete(key);
  }
}
