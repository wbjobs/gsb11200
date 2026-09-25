/* 同步层：BroadcastChannel 实时广播 + 版本向量反熵（离线恢复自动合并）
 * 另加 IndexedDB 共享存储轮询：某标签页离线操作后直接关闭，其余标签页
 * 也能从共享 IndexedDB 中捡到它的操作，保证不丢。
 *
 * 消息类型：
 *  - hello {vv}        上线/心跳：携带版本向量，触发反熵与在线名单
 *  - ops  {ops}        操作广播（本地操作即时广播 + 反熵补齐）
 *  - need {vv, to}     请求对方推送我缺失的操作
 *  - ping/pong         延迟测量
 *
 * 离线模拟：setOnline(false) 后停止收发（操作照常写入 IndexedDB），
 * 恢复在线后立即广播 hello 触发双向反熵合并。
 */
(function (root) {
  'use strict';

  function createSync(opts) {
    const store = opts.store;
    const nodeId = store.nodeId;
    const channel = new BroadcastChannel(opts.channelName || 'crdt-kanban-v1');
    const peers = new Map(); // nodeId -> { lastSeen, rtt }
    let online = true;
    let seqPing = 0;
    const pendingPings = new Map();
    const listeners = { peers: [], online: [], latency: [] };

    function emit(name, arg) {
      for (const fn of listeners[name]) { try { fn(arg); } catch (e) { console.error(e); } }
    }

    function post(msg) {
      if (!online) return; // 离线：不发送，操作已持久化，恢复后反熵合并
      msg.from = nodeId;
      channel.postMessage(msg);
    }

    function broadcastOps(ops) {
      post({ kind: 'ops', ops });
    }

    // 本地操作 -> 立即广播
    store.on('ops', (ops) => broadcastOps(ops));

    function handleMessage(ev) {
      if (!online) return; // 离线：拒收，恢复后通过反熵补齐
      const msg = ev.data;
      if (!msg || msg.from === nodeId) return;
      switch (msg.kind) {
        case 'hello': {
          const isNew = !peers.has(msg.from);
          peers.set(msg.from, Object.assign(peers.get(msg.from) || {}, { lastSeen: Date.now() }));
          if (isNew) emit('peers', peerList());
          // 反熵：对方缺的我推过去；我缺的向对方要
          const forThem = store.missingOps(msg.vv || {});
          if (forThem.length) post({ kind: 'ops', ops: forThem, to: msg.from });
          post({ kind: 'need', vv: store.getVersionVector(), to: msg.from });
          break;
        }
        case 'need': {
          if (msg.to && msg.to !== nodeId) break;
          const forThem = store.missingOps(msg.vv || {});
          if (forThem.length) post({ kind: 'ops', ops: forThem, to: msg.from });
          break;
        }
        case 'ops': {
          if (msg.to && msg.to !== nodeId) break;
          store.applyRemote(msg.ops);
          break;
        }
        case 'ping': {
          post({ kind: 'pong', to: msg.from, pingId: msg.pingId });
          break;
        }
        case 'pong': {
          if (msg.to !== nodeId) break;
          const t0 = pendingPings.get(msg.pingId);
          if (t0 != null) {
            pendingPings.delete(msg.pingId);
            const rtt = Date.now() - t0;
            const p = peers.get(msg.from) || {};
            p.rtt = p.rtt == null ? rtt : Math.round(p.rtt * 0.7 + rtt * 0.3);
            p.lastSeen = Date.now();
            peers.set(msg.from, p);
            emit('latency', { peer: msg.from, rtt });
          }
          break;
        }
      }
    }

    channel.addEventListener('message', handleMessage);

    // 心跳：在线名单维护 + 周期性反熵（兜底，保证最终一致）
    const heartbeat = setInterval(() => {
      if (!online) return;
      post({ kind: 'hello', vv: store.getVersionVector() });
      // 延迟测量
      const id = ++seqPing;
      pendingPings.set(id, Date.now());
      post({ kind: 'ping', pingId: id });
      // 清理失联节点（标签页关闭）
      const now = Date.now();
      let changed = false;
      for (const [id, p] of peers) {
        if (now - p.lastSeen > 6000) { peers.delete(id); changed = true; }
      }
      if (changed) emit('peers', peerList());
      // 共享 IndexedDB 反熵：捡回「离线操作后关闭」标签页留下的操作
      if (opts.loadPersisted) {
        opts.loadPersisted().then((ops) => {
          if (ops && ops.length) store.applyRemote(ops);
        }).catch(() => {});
      }
    }, 2000);

    function peerList() {
      return Array.from(peers.entries()).map(([id, p]) => ({ id, rtt: p.rtt }));
    }

    // 上线打招呼，触发双向反熵
    function announce() {
      post({ kind: 'hello', vv: store.getVersionVector() });
    }

    const api = {
      on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
      peers: peerList,
      announce,
      setOnline(v) {
        online = !!v;
        emit('online', online);
        if (online) announce(); // 恢复在线：立即反熵合并
      },
      isOnline() { return online; },
      close() {
        clearInterval(heartbeat);
        channel.close();
      },
    };

    // 启动：广播存在并拉取缺失操作
    setTimeout(announce, 50);
    return api;
  }

  const exp = { createSync };
  if (typeof module === 'object' && module.exports) module.exports = exp;
  else root.KanbanSync = exp;
})(typeof self !== 'undefined' ? self : this);
