import test from 'node:test';
import assert from 'node:assert/strict';
import { CRDTStore } from '../js/crdt.js';
import { SyncEngine } from '../js/sync.js';

class FakeBus {
  constructor() {
    this.channels = new Set();
    this.blocked = false;
    this.pending = [];
  }

  connect() {
    const bus = this;
    const listeners = [];
    const ch = {
      _listeners: listeners,
      addEventListener: (type, fn) => listeners.push(fn),
      postMessage: (msg) => {
        const copy = structuredClone(msg);
        if (bus.blocked) bus.pending.push({ from: ch, msg: copy });
        else bus.deliver(ch, copy);
      },
      close: () => bus.channels.delete(ch),
    };
    this.channels.add(ch);
    return ch;
  }

  deliver(fromCh, msg) {
    for (const ch of this.channels) {
      if (ch === fromCh) continue;
      queueMicrotask(() => {
        for (const fn of ch._listeners) fn({ data: msg });
      });
    }
  }

  flush({ shuffle = false } = {}) {
    const batch = this.pending.splice(0);
    if (shuffle) {
      for (let i = batch.length - 1; i > 0; i -= 1) {
        const j = (i * 2654435761) % (i + 1);
        [batch[i], batch[j]] = [batch[j], batch[i]];
      }
    }
    for (const { from, msg } of batch) this.deliver(from, msg);
  }
}

// deliver 用 queueMicrotask，需要让出事件循环
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeDB() {
  return { ops: [], putOp(op) { this.ops.push(op); return Promise.resolve(); } };
}

function makeEngine(bus, id) {
  const store = new CRDTStore(id);
  const db = fakeDB();
  const engine = new SyncEngine({
    store, db, channel: bus.connect(),
    onChange: () => {}, onPresence: () => {},
  });
  return { store, db, engine };
}

function snapshot(store) {
  return JSON.stringify(
    [...store.cards.values()]
      .map((c) => ({ id: c.id, title: c.title, column: c.column, posKey: c.posKey, deleted: c.deleted }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
}

test('4 个标签页实时同步：一端的操作广播到其余三端', async () => {
  const bus = new FakeBus();
  const tabs = ['t1', 't2', 't3', 't4'].map((id) => makeEngine(bus, id));
  for (const t of tabs) t.engine.start();
  await tick();

  tabs[0].engine.localOp(tabs[0].store.createCard({ cardId: 'x', title: 'hello', desc: '', column: 'todo', posKey: 'V' }));
  await tick();

  for (const t of tabs) {
    assert.equal(t.store.cards.get('x').title, 'hello');
    assert.equal(snapshot(t.store), snapshot(tabs[0].store));
  }
});

test('消息乱序：阻塞后乱序投递，状态仍收敛', async () => {
  const bus = new FakeBus();
  const a = makeEngine(bus, 't1');
  const b = makeEngine(bus, 't2');
  a.engine.start();
  b.engine.start();
  await tick();

  bus.blocked = true;
  a.engine.localOp(a.store.createCard({ cardId: 'c', title: 'c', desc: '', column: 'todo', posKey: 'V' }));
  a.engine.localOp(a.store.moveCard('c', 'doing', 'k'));
  a.engine.localOp(a.store.editCard('c', { title: 'c2', desc: '' }));
  a.engine.localOp(a.store.moveCard('c', 'done', 'z'));
  bus.flush({ shuffle: true });
  await tick();

  assert.equal(snapshot(a.store), snapshot(b.store));
  assert.equal(b.store.cards.get('c').column, 'done');
  assert.equal(b.store.cards.get('c').title, 'c2');
});

test('离线操作恢复后自动合并（双向）', async () => {
  const bus = new FakeBus();
  const a = makeEngine(bus, 't1');
  const b = makeEngine(bus, 't2');
  a.engine.start();
  b.engine.start();
  await tick();

  a.engine.localOp(a.store.createCard({ cardId: 'shared', title: 's', desc: '', column: 'todo', posKey: 'V' }));
  await tick();

  // B 离线：本地操作缓存，不广播也收不到
  b.engine.setOnline(false);
  b.engine.localOp(b.store.createCard({ cardId: 'b-offline', title: 'B离线', desc: '', column: 'todo', posKey: 'V0' }));
  b.engine.localOp(b.store.moveCard('shared', 'done', 'z'));
  a.engine.localOp(a.store.createCard({ cardId: 'a-online', title: 'A在线', desc: '', column: 'todo', posKey: 'k' }));
  await tick();

  assert.equal(a.store.cards.has('b-offline'), false);
  assert.equal(b.store.cards.has('a-online'), false);

  // B 恢复在线：先发缓存操作，再 sync-request 拉取缺失操作
  b.engine.setOnline(true);
  await tick();

  assert.equal(snapshot(a.store), snapshot(b.store));
  assert.equal(a.store.cards.get('b-offline').title, 'B离线');
  assert.equal(b.store.cards.get('a-online').title, 'A在线');
  assert.equal(a.store.cards.get('shared').column, 'done');
});

test('刷新不丢数据：从 IndexedDB 重放 + 反熵同步恢复全部状态', async () => {
  const bus = new FakeBus();
  const a = makeEngine(bus, 't1');
  const b = makeEngine(bus, 't2');
  a.engine.start();
  b.engine.start();
  await tick();

  a.engine.localOp(a.store.createCard({ cardId: 'p1', title: '持久化', desc: '', column: 'todo', posKey: 'V' }));
  a.engine.localOp(a.store.moveCard('p1', 'doing', 'k'));
  await tick();

  // 模拟 B 刷新：从自己的 IDB 重放，再向同伴要缺失的操作
  const b2store = new CRDTStore('t2');
  b2store.applyOps(b.db.ops);
  const b2 = new SyncEngine({
    store: b2store, db: fakeDB(), channel: bus.connect(),
    onChange: () => {}, onPresence: () => {},
  });
  b2.start();
  await tick();

  assert.equal(snapshot(b2store), snapshot(a.store));
});

test('删除与编辑的跨标签页冲突：删除优先且各端一致', async () => {
  const bus = new FakeBus();
  const a = makeEngine(bus, 't1');
  const b = makeEngine(bus, 't2');
  a.engine.start();
  b.engine.start();
  await tick();

  a.engine.localOp(a.store.createCard({ cardId: 'victim', title: 'old', desc: '', column: 'todo', posKey: 'V' }));
  await tick();

  bus.blocked = true;
  a.engine.localOp(a.store.deleteCard('victim'));
  b.engine.localOp(b.store.editCard('victim', { title: 'concurrent-edit', desc: '' }));
  bus.flush({ shuffle: true });
  await tick();

  assert.equal(a.store.cards.get('victim').deleted, true);
  assert.equal(b.store.cards.get('victim').deleted, true);
  assert.equal(snapshot(a.store), snapshot(b.store));
});
