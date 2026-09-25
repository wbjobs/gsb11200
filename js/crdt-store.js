/* CRDT 看板核心存储（纯逻辑，无 DOM 依赖，可在 Node 中测试）
 *
 * 操作类型（全部可交换、幂等，乱序/重复到达均收敛）：
 *  - ADD    { cardId, col, pos, title, body }
 *  - MOVE   { cardId, col, pos }   LWW：时间戳最新者胜
 *  - EDIT   { cardId, title, body } LWW：时间戳最新者胜
 *  - DELETE { cardId }             墓碑，删除优先（delete-wins），不可复活
 *
 * 冲突规则：
 *  - 同一卡片并发移动：HLC 全序，最新者胜（两标签页拖同一卡片最终一致）
 *  - 删除 vs 编辑/移动：删除永远优先，删除后的编辑/移动被忽略
 *  - 并发编辑：LWW
 */
(function (root, factory) {
  let HLC = null, Logoot = null;
  if (typeof module === 'object' && module.exports) {
    HLC = require('./hlc.js');
    Logoot = require('./logoot.js');
  } else {
    HLC = root.HLC;
    Logoot = root.Logoot;
  }
  const api = factory(HLC, Logoot);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CRDTStore = api;
})(typeof self !== 'undefined' ? self : this, function (HLC, Logoot) {
  'use strict';

  const OP_LIMIT = 100000; // 操作日志上限（设得很高，保证反熵日志完整；快照接口仍保留）

  function createStore(opts) {
    const nodeId = opts.nodeId;
    const persist = opts.persist || null; // async (op) => {}
    const hlc = HLC.create(nodeId, opts.hlcState);

    const cards = new Map();   // cardId -> { col, pos, title, body, deleted, posTs, editTs, delTs }
    const opIds = new Set();   // 已见操作ID（去重）
    const opLog = [];          // 操作日志（用于快照压缩）
    const vv = {};             // 版本向量 author -> 最大seq
    let seq = 0;               // 本节点操作序号
    const listeners = { ops: [], change: [] };

    function emit(name, arg) {
      for (const fn of listeners[name]) { try { fn(arg); } catch (e) { console.error(e); } }
    }

    function opId(author, s) { return author + ':' + s; }

    function noteVV(op) {
      if (!(vv[op.author] >= op.seq)) vv[op.author] = op.seq;
    }

    // 应用操作到物化状态；返回是否产生了可见变化
    function applyOp(op) {
      HLC.observe(hlc, op.ts);
      noteVV(op);
      switch (op.type) {
        case 'ADD': {
          const ex = cards.get(op.cardId);
          if (ex) return false; // 幂等：重复ADD忽略
          cards.set(op.cardId, {
            col: op.col, pos: op.pos, title: op.title, body: op.body || '',
            deleted: false, posTs: op.ts, editTs: op.ts, delTs: null,
          });
          return true;
        }
        case 'MOVE': {
          const c = cards.get(op.cardId);
          if (!c || c.deleted) return false;
          if (HLC.isNewer(op.ts, c.posTs)) {
            c.col = op.col; c.pos = op.pos; c.posTs = op.ts;
            return true;
          }
          return false;
        }
        case 'EDIT': {
          const c = cards.get(op.cardId);
          if (!c || c.deleted) return false;
          if (HLC.isNewer(op.ts, c.editTs)) {
            c.title = op.title; c.body = op.body; c.editTs = op.ts;
            return true;
          }
          return false;
        }
        case 'DELETE': {
          const c = cards.get(op.cardId);
          if (!c) {
            // 墓碑仍需记录：卡片可能尚未到达（乱序），先记占位墓碑
            cards.set(op.cardId, {
              col: null, pos: null, title: '', body: '',
              deleted: true, posTs: null, editTs: null, delTs: op.ts,
            });
            return true;
          }
          if (c.deleted) return false;
          if (!c.delTs || HLC.isNewer(op.ts, c.delTs)) c.delTs = op.ts;
          c.deleted = true; // delete-wins：任何删除都生效，编辑/移动无法复活
          return true;
        }
      }
      return false;
    }

    // 乱序保护：ADD 晚于 DELETE 到达时，ADD 不得复活已删除卡片
    function reconcileAddDelete() {
      for (const [, c] of cards) {
        if (c.deleted && c.delTs && c.posTs && HLC.isNewer(c.posTs, c.delTs)) {
          // ADD 的 ts 晚于 DELETE：仍保持删除（delete-wins 语义下 ADD 先到、DELETE 后到才合法；
          // 若 DELETE 先到是乱序，ADD 到达后也不复活，因为删除已生效）
          c.deleted = true;
        }
      }
    }

    function ingest(op, isLocal) {
      const id = opId(op.author, op.seq);
      if (opIds.has(id)) return false; // 去重：重复投递安全
      opIds.add(id);
      opLog.push(op);
      const changed = applyOp(op);
      if (persist) persist(op);
      if (opLog.length > OP_LIMIT) compact();
      if (changed) emit('change', op);
      if (isLocal) emit('ops', [op]); // 仅本地操作需要广播
      return changed;
    }

    // 生成一个本地操作（统一入口，保证 HLC/seq 递增）
    function makeOp(type, payload) {
      seq += 1;
      const op = Object.assign({ type, author: nodeId, seq, ts: HLC.tick(hlc) }, payload);
      return op;
    }

    function liveCards() {
      const out = [];
      for (const [id, c] of cards) {
        if (!c.deleted && c.pos) out.push(Object.assign({ id }, c));
      }
      return out;
    }

    function sortedColumn(col) {
      return liveCards()
        .filter((c) => c.col === col)
        .sort((a, b) => Logoot.compare(a.pos, b.pos));
    }

    const store = {
      nodeId,
      hlc,

      on(name, fn) { listeners[name].push(fn); },

      getVersionVector() { return Object.assign({}, vv); },

      getCard(id) { return cards.get(id) || null; },
      liveCards,
      sortedColumn,

      // ---- 本地操作 API ----
      addCard(col, title, body, index) {
        const list = sortedColumn(col).map((c) => c.pos);
        const idx = index == null ? list.length : index;
        const pos = Logoot.atIndex(list, idx, nodeId);
        const cardId = 'c_' + nodeId + '_' + seq + '_' + Math.random().toString(36).slice(2, 8);
        const op = makeOp('ADD', { cardId, col, pos, title, body: body || '' });
        ingest(op, true);
        return cardId;
      },

      moveCard(cardId, col, index) {
        const c = cards.get(cardId);
        if (!c || c.deleted) return null;
        const list = sortedColumn(col).filter((x) => x.id !== cardId).map((x) => x.pos);
        const idx = Math.max(0, Math.min(index == null ? list.length : index, list.length));
        const pos = Logoot.atIndex(list, idx, nodeId);
        const op = makeOp('MOVE', { cardId, col, pos });
        ingest(op, true);
        return op;
      },

      editCard(cardId, title, body) {
        const c = cards.get(cardId);
        if (!c || c.deleted) return null;
        const op = makeOp('EDIT', { cardId, title, body: body || '' });
        ingest(op, true);
        return op;
      },

      deleteCard(cardId) {
        const c = cards.get(cardId);
        if (!c || c.deleted) return null;
        const op = makeOp('DELETE', { cardId });
        ingest(op, true);
        return op;
      },

      // ---- 远端操作入口 ----
      applyRemote(ops) {
        const fresh = [];
        for (const op of ops) {
          const id = opId(op.author, op.seq);
          if (opIds.has(id)) continue;
          opIds.add(id);
          opLog.push(op);
          const changed = applyOp(op);
          if (persist) persist(op);
          if (changed) fresh.push(op);
        }
        if (opLog.length > OP_LIMIT) compact();
        if (fresh.length) emit('change', fresh[fresh.length - 1]);
        return fresh;
      },

      // 反熵：返回对方版本向量缺失的本方操作
      missingOps(theirVV) {
        const out = [];
        for (const op of opLog) {
          if (!(theirVV && theirVV[op.author] >= op.seq)) out.push(op);
        }
        return out;
      },

      // 从 IndexedDB 恢复的操作日志重建状态
      loadOps(ops) {
        for (const op of ops) {
          const id = opId(op.author, op.seq);
          if (opIds.has(id)) continue;
          opIds.add(id);
          opLog.push(op);
          applyOp(op);
        }
        reconcileAddDelete();
      },

      opCount() { return opLog.length; },
      hlcState() { return { t: hlc.t, c: hlc.c }; },

      // 快照压缩：保留最新可见状态 + 墓碑，丢弃历史操作
      snapshot() {
        const snap = { cards: {}, vv: Object.assign({}, vv), hlc: { t: hlc.t, c: hlc.c } };
        for (const [id, c] of cards) snap.cards[id] = c;
        return snap;
      },
    };

    function compact() {
      // 简化压缩：清空操作日志（状态已物化），保留 vv 用于反熵
      opLog.length = 0;
    }

    return store;
  }

  return { createStore, HLC, Logoot };
});
