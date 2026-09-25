// IndexedDB 持久化：操作日志即真相，刷新后重放即可恢复。

export function openDB(name = 'kanban-crdt') {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ops')) {
        db.createObjectStore('ops', { keyPath: 'opId' });
      }
    };
    req.onsuccess = () => resolve(wrap(req.result));
    req.onerror = () => reject(req.error);
  });
}

function wrap(db) {
  return {
    putOp(op) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('ops', 'readwrite');
        tx.objectStore('ops').put(op);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    getAllOps() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('ops', 'readonly');
        const req = tx.objectStore('ops').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },
  };
}
