// 同步引擎：BroadcastChannel 广播 + 离线缓存 + 基于向量时钟的反熵（anti-entropy）。
// channel 与 db 均通过注入传入，便于在 Node 中用假实现做确定性测试。

export class SyncEngine {
  constructor({ store, db, channel, onChange, onPresence }) {
    this.store = store;
    this.db = db;
    this.channel = channel;
    this.onChange = onChange || (() => {});
    this.onPresence = onPresence || (() => {});
    this.online = true;
    this.offlineQueue = [];
    this.peers = new Map();
    this.peerId = store.clientId;
    this._listener = (event) => this._onMessage(event.data);
    channel.addEventListener('message', this._listener);
    this._pruneTimer = setInterval(() => this._heartbeat(), 3000);
    if (typeof this._pruneTimer.unref === 'function') this._pruneTimer.unref();
  }

  start() {
    this._post({ kind: 'presence-hello', from: this.peerId });
    this.requestSync();
  }

  localOp(op) {
    this.store.applyOp(op);
    this._persist(op);
    if (this.online) {
      this._post({ kind: 'op', from: this.peerId, op });
    } else {
      this.offlineQueue.push(op);
    }
    this.onChange();
  }

  setOnline(online) {
    this.online = online;
    if (online) {
      const queued = this.offlineQueue.splice(0);
      for (const op of queued) {
        this._post({ kind: 'op', from: this.peerId, op });
      }
      this._post({ kind: 'presence-hello', from: this.peerId });
      this.requestSync();
    }
  }

  requestSync() {
    this._post({ kind: 'sync-request', from: this.peerId, vector: this.store.getVector() });
  }

  peerCount() {
    return this.peers.size;
  }

  close() {
    clearInterval(this._pruneTimer);
    this._post({ kind: 'presence-bye', from: this.peerId });
  }

  _onMessage(msg) {
    if (!msg || msg.from === this.peerId) return;
    if (!this.online) return;
    switch (msg.kind) {
      case 'op': {
        if (this.store.applyOp(msg.op)) {
          this._persist(msg.op);
          this.onChange();
        }
        break;
      }
      case 'sync-request': {
        const ops = this.store.missingOpsFor(msg.vector || {});
        this._post({ kind: 'sync-response', to: msg.from, from: this.peerId, ops });
        break;
      }
      case 'sync-response': {
        if (msg.to !== this.peerId) break;
        if (this.store.applyOps(msg.ops)) {
          for (const op of msg.ops) this._persist(op);
          this.onChange();
        }
        break;
      }
      case 'presence-hello': {
        this._touch(msg.from);
        this._post({ kind: 'presence-ack', from: this.peerId, to: msg.from });
        break;
      }
      case 'presence-ack': {
        if (msg.to === '*' || msg.to === this.peerId) this._touch(msg.from);
        break;
      }
      case 'presence-bye': {
        if (this.peers.delete(msg.from)) this.onPresence(this.peers.size);
        break;
      }
      default:
        break;
    }
  }

  _touch(id) {
    this.peers.set(id, Date.now());
    this.onPresence(this.peers.size);
  }

  _heartbeat() {
    const now = Date.now();
    let changed = false;
    for (const [id, seen] of this.peers) {
      if (now - seen > 8000) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.onPresence(this.peers.size);
    if (this.online) this._post({ kind: 'presence-ack', from: this.peerId, to: '*' });
  }

  _persist(op) {
    Promise.resolve(this.db.putOp(op)).catch(() => {});
  }

  _post(msg) {
    this.channel.postMessage(msg);
  }
}
