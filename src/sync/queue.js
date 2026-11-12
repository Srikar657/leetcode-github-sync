/**
 * queue.js  (src/sync/)
 *
 * A small persisted FIFO queue. The head item is only removed AFTER it has
 * been fully handled, so a service-worker restart mid-item re-processes that
 * item (safe: every sync step is idempotent) instead of losing it.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  class PersistedQueue {
    constructor(storageKey) {
      this.storageKey = storageKey;
      this.items = [];
      this._loaded = false;
    }

    async load() {
      const result = await LGS.storage.get(this.storageKey);
      this.items = result[this.storageKey] || [];
      this._loaded = true;
      return this.items;
    }

    async _persist() { await LGS.storage.set({ [this.storageKey]: this.items }); }

    async pushMany(items) {
      if (!this._loaded) await this.load();
      this.items.push(...items);
      await this._persist();
    }

    async peek() {
      if (!this._loaded) await this.load();
      return this.items[0] || null;
    }

    async removeHead() {
      if (!this._loaded) await this.load();
      this.items.shift();
      await this._persist();
    }

    async clear() {
      this.items = [];
      this._loaded = true;
      await this._persist();
    }

    async size() {
      if (!this._loaded) await this.load();
      return this.items.length;
    }

    /** Force the next access to re-read storage (after a worker restart). */
    invalidate() { this._loaded = false; }
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.PersistedQueue = PersistedQueue;
})(typeof self !== 'undefined' ? self : window);
