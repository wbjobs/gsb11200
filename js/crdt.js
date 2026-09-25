// CRDT 核心：Lamport 时钟 + LWW 寄存器 + 永久墓碑（删除优先）。
// 所有操作幂等、可交换，因此消息乱序、重复、离线合并后各端状态必然收敛。

export function compareClock(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
}

export class CRDTStore {
  constructor(clientId) {
    this.clientId = clientId;
    this.lamport = 0;
    this.counter = 0;
    this.cards = new Map();
    this.seenOps = new Set();
    this.log = [];
    this.vector = {};
  }

  tick() {
    this.lamport += 1;
    return this.lamport;
  }

  makeOp(type, payload) {
    const lamport = this.tick();
    this.counter += 1;
    return {
      opId: `${this.clientId}:${this.counter}`,
      type,
      lamport,
      clientId: this.clientId,
      ...payload,
    };
  }

  createCard({ cardId, title, desc, column, posKey }) {
    return this.makeOp('create', { cardId, title, desc, column, posKey });
  }

  editCard(cardId, { title, desc }) {
    return this.makeOp('edit', { cardId, title, desc });
  }

  moveCard(cardId, column, posKey) {
    return this.makeOp('move', { cardId, column, posKey });
  }

  deleteCard(cardId) {
    return this.makeOp('delete', { cardId });
  }

  applyOp(op) {
    if (this.seenOps.has(op.opId)) return false;
    this.seenOps.add(op.opId);
    this.log.push(op);
    this.lamport = Math.max(this.lamport, op.lamport);
    this.vector[op.clientId] = Math.max(this.vector[op.clientId] || 0, op.lamport);

    const clock = { lamport: op.lamport, clientId: op.clientId };
    // 操作可能先于 create 到达（消息乱序）：先建占位记录，字段全部走 LWW 合并，
    // 保证 applyOp 可交换、幂等，任意到达顺序都收敛到同一状态。
    const card = this._ensureCard(op.cardId);

    switch (op.type) {
      case 'create': {
        card.created = true;
        this._mergeText(card, clock, op);
        this._mergeMove(card, clock, op);
        break;
      }
      case 'edit': {
        this._mergeText(card, clock, op);
        break;
      }
      case 'move': {
        this._mergeMove(card, clock, op);
        break;
      }
      case 'delete': {
        // 永久墓碑：删除优先于并发的编辑/移动（仅控制可见性，字段仍收敛）
        if (!card.deleted) {
          card.deleted = true;
          card.deleteClock = clock;
        }
        break;
      }
      default:
        break;
    }
    return true;
  }

  _ensureCard(cardId) {
    let card = this.cards.get(cardId);
    if (!card) {
      const zero = { lamport: 0, clientId: '' };
      card = {
        id: cardId,
        created: false,
        title: '',
        titleClock: zero,
        desc: '',
        descClock: zero,
        column: 'todo',
        posKey: '',
        moveClock: zero,
        deleted: false,
        deleteClock: null,
      };
      this.cards.set(cardId, card);
    }
    return card;
  }

  _mergeText(card, clock, op) {
    if (compareClock(clock, card.titleClock) > 0) {
      card.title = op.title;
      card.titleClock = clock;
    }
    if (compareClock(clock, card.descClock) > 0) {
      card.desc = op.desc || '';
      card.descClock = clock;
    }
  }

  _mergeMove(card, clock, op) {
    if (compareClock(clock, card.moveClock) > 0) {
      card.column = op.column;
      card.posKey = op.posKey;
      card.moveClock = clock;
    }
  }

  applyOps(ops) {
    let changed = false;
    for (const op of ops) {
      changed = this.applyOp(op) || changed;
    }
    return changed;
  }

  getVector() {
    return { ...this.vector };
  }

  missingOpsFor(vector) {
    return this.log.filter((op) => op.lamport > (vector[op.clientId] || 0));
  }

  visibleCards(column) {
    return [...this.cards.values()]
      .filter((c) => c.created && !c.deleted && (column === undefined || c.column === column))
      .sort((a, b) => {
        if (a.posKey !== b.posKey) return a.posKey < b.posKey ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }
}
