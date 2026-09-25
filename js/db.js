/* IndexedDB 持久化层
 * - ops: 操作日志（key = author:seq），刷新/关闭后重开可完整恢复
 * - meta: 各节点的 HLC 时钟状态
 */
(function (root) {
  'use strict';

  const DB_NAME = 'crdt-kanban';
  const DB_VERSION = 1;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out._result !== undefined ? out._result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  const api = {
    open,

    async putOp(db, op) {
      return tx(db, 'ops', 'readwrite', (s) => s.put(op, op.author + ':' + op.seq));
    },

    async getAllOps(db) {
      return new Promise((resolve, reject) => {
        const t = db.transaction('ops', 'readonly');
        const req = t.objectStore('ops').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    async putMeta(db, key, value) {
      return tx(db, 'meta', 'readwrite', (s) => s.put(value, key));
    },

    async getMeta(db, key) {
      return new Promise((resolve, reject) => {
        const t = db.transaction('meta', 'readonly');
        const req = t.objectStore('meta').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async clearAll(db) {
      await tx(db, 'ops', 'readwrite', (s) => s.clear());
      await tx(db, 'meta', 'readwrite', (s) => s.clear());
    },
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KanbanDB = api;
})(typeof self !== 'undefined' ? self : this);
