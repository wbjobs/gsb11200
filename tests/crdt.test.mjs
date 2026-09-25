import test from 'node:test';
import assert from 'node:assert/strict';
import { CRDTStore } from '../js/crdt.js';
import { generateKeyBetween } from '../js/fractional.js';

function snapshot(store) {
  return JSON.stringify(
    [...store.cards.values()]
      .map((c) => ({
        id: c.id, title: c.title, desc: c.desc,
        column: c.column, posKey: c.posKey, deleted: c.deleted,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
}

function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, seed) {
  const rand = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function makePair() {
  const a = new CRDTStore('tab-A');
  const b = new CRDTStore('tab-B');
  const seed = a.createCard({ cardId: 'c1', title: '卡片1', desc: '', column: 'todo', posKey: 'V' });
  a.applyOp(seed);
  b.applyOp(seed);
  return { a, b };
}

test('两个标签页拖拽同一卡片最终一致（LWW 决定唯一赢家）', () => {
  const { a, b } = makePair();
  const moveA = a.moveCard('c1', 'doing', generateKeyBetween(null, null));
  const moveB = b.moveCard('c1', 'done', generateKeyBetween(null, null));

  a.applyOp(moveA);
  b.applyOp(moveB);
  a.applyOp(moveB);
  b.applyOp(moveA);

  assert.equal(snapshot(a), snapshot(b));
  const winner = JSON.parse(snapshot(a))[0];
  // lamport 相同，clientId 大者胜：tab-B 的移动生效
  assert.equal(winner.column, 'done');
});

test('排序冲突：并发插入同一间隙后顺序确定且一致', () => {
  const a = new CRDTStore('tab-A');
  const b = new CRDTStore('tab-B');
  const base = a.createCard({ cardId: 'base', title: 'base', desc: '', column: 'todo', posKey: 'V' });
  a.applyOp(base);
  b.applyOp(base);

  const insertA = a.createCard({ cardId: 'cA', title: 'A', desc: '', column: 'todo', posKey: generateKeyBetween('V', null) });
  const insertB = b.createCard({ cardId: 'cB', title: 'B', desc: '', column: 'todo', posKey: generateKeyBetween('V', null) });
  a.applyOp(insertA);
  b.applyOp(insertB);

  a.applyOp(insertB);
  b.applyOp(insertA);

  assert.equal(snapshot(a), snapshot(b));
  const orderA = a.visibleCards('todo').map((c) => c.id);
  const orderB = b.visibleCards('todo').map((c) => c.id);
  assert.deepEqual(orderA, orderB);
});

test('删除与编辑冲突：删除优先，且与消息到达顺序无关', () => {
  for (const order of ['edit-first', 'delete-first']) {
    const { a, b } = makePair();
    const del = a.deleteCard('c1');
    const edit = b.editCard('c1', { title: '并发修改', desc: 'x' });
    a.applyOp(del);
    b.applyOp(edit);

    if (order === 'edit-first') {
      a.applyOp(edit);
      a.applyOp(del);
      b.applyOp(del);
      b.applyOp(edit);
    } else {
      a.applyOp(del);
      a.applyOp(edit);
      b.applyOp(edit);
      b.applyOp(del);
    }

    assert.equal(a.cards.get('c1').deleted, true);
    assert.equal(b.cards.get('c1').deleted, true);
    assert.equal(snapshot(a), snapshot(b));
    assert.equal(a.visibleCards('todo').length, 0);
  }
});

test('消息乱序不丢操作：随机打乱的 60 个操作收敛到相同状态', () => {
  const a = new CRDTStore('tab-A');
  const b = new CRDTStore('tab-B');
  const ops = [];
  const keys = { todo: null, doing: null, done: null };
  const columns = Object.keys(keys);

  for (let i = 0; i < 20; i += 1) {
    const column = columns[i % 3];
    const posKey = generateKeyBetween(keys[column], null);
    keys[column] = posKey;
    const op = a.createCard({ cardId: `card-${i}`, title: `t${i}`, desc: '', column, posKey });
    a.applyOp(op);
    ops.push(op);
  }
  for (let i = 0; i < 20; i += 1) {
    const op = a.moveCard(`card-${i}`, columns[(i + 1) % 3], generateKeyBetween(null, null));
    a.applyOp(op);
    ops.push(op);
  }
  for (let i = 0; i < 20; i += 1) {
    const op = i % 2 === 0 ? a.editCard(`card-${i}`, { title: `edited-${i}`, desc: 'd' }) : a.deleteCard(`card-${i}`);
    a.applyOp(op);
    ops.push(op);
  }

  for (const op of shuffled(ops, 42)) b.applyOp(op);
  // 重复投递也不应改变结果
  for (const op of shuffled(ops, 7)) b.applyOp(op);

  assert.equal(snapshot(a), snapshot(b));
});

test('离线合并：两端各自离线操作，交换日志后一致', () => {
  const { a, b } = makePair();
  const opsA = [];
  const opsB = [];

  const moveA = a.moveCard('c1', 'doing', 'k');
  a.applyOp(moveA);
  opsA.push(moveA);
  const createA = a.createCard({ cardId: 'c2', title: 'A离线新建', desc: '', column: 'todo', posKey: 'V0' });
  a.applyOp(createA);
  opsA.push(createA);

  const editB = b.editCard('c1', { title: 'B离线编辑', desc: '' });
  b.applyOp(editB);
  opsB.push(editB);
  const delB = b.deleteCard('c1');
  b.applyOp(delB);
  opsB.push(delB);

  // 恢复连接：双向交换并打乱顺序
  for (const op of shuffled(opsB, 1)) a.applyOp(op);
  for (const op of shuffled(opsA, 2)) b.applyOp(op);

  assert.equal(snapshot(a), snapshot(b));
  // 删除优先：c1 被删除，B 的离线编辑与 A 的离线移动都被墓碑吞掉
  assert.equal(a.cards.get('c1').deleted, true);
  assert.equal(a.cards.get('c2').title, 'A离线新建');
});

test('操作幂等：重复应用同一操作不改变状态', () => {
  const { a } = makePair();
  const before = snapshot(a);
  const move = a.moveCard('c1', 'done', 'z');
  a.applyOp(move);
  const mid = snapshot(a);
  a.applyOp(move);
  a.applyOp(move);
  assert.equal(snapshot(a), mid);
  assert.notEqual(mid, before);
});

test('generateKeyBetween：500 次随机插入始终保持有序', () => {
  const rand = mulberry32(123);
  const keys = [];
  for (let i = 0; i < 500; i += 1) {
    const idx = Math.floor(rand() * (keys.length + 1));
    const prev = idx > 0 ? keys[idx - 1] : null;
    const next = idx < keys.length ? keys[idx] : null;
    const key = generateKeyBetween(prev, next);
    keys.splice(idx, 0, key);
    for (let j = 1; j < keys.length; j += 1) {
      assert.ok(keys[j - 1] < keys[j], `顺序被破坏: ${keys[j - 1]} !< ${keys[j]}`);
    }
  }
});

test('generateKeyBetween：非法输入抛错', () => {
  assert.throws(() => generateKeyBetween('b', 'a'));
  assert.throws(() => generateKeyBetween('a', 'a'));
});
