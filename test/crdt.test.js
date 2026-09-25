/* CRDT 核心测试：Node 环境运行，模拟多标签页网络（延迟/乱序/离线/重启） */
'use strict';
const assert = require('assert');
const { createStore } = require('../js/crdt-store.js');
const Logoot = require('../js/logoot.js');
const HLC = require('../js/hlc.js');

// ---- 网络模拟器：支持延迟、乱序、分区（离线）、节点重启 ----
class Network {
  constructor() { this.nodes = new Map(); this.queue = []; this.now = 0; this.partitions = new Set(); }
  add(node) { this.nodes.set(node.id, node); }
  // 发送：进入优先队列，随机延迟 0~50ms 模拟乱序
  send(fromId, msg) {
    const delay = Math.floor(Math.random() * 50);
    this.queue.push({ at: this.now + delay, fromId, msg });
  }
  partition(ids) { for (const id of ids) this.partitions.add(id); }
  heal() { this.partitions.clear(); }
  tick(ms) {
    this.now += ms;
    const due = this.queue.filter((m) => m.at <= this.now);
    this.queue = this.queue.filter((m) => m.at > this.now);
    // 打乱投递顺序，模拟乱序
    due.sort(() => Math.random() - 0.5);
    for (const m of due) {
      for (const [id, node] of this.nodes) {
        if (id === m.fromId) continue;
        if (this.partitions.has(id) || this.partitions.has(m.fromId)) continue; // 离线：收不到
        node.receive(m.msg, m.fromId);
      }
    }
  }
  run(ms) { for (let i = 0; i < ms; i += 10) this.tick(10); }
  pending() { return this.queue.length; }
}

// 模拟一个标签页：store + 收发 + 本地持久化（重启恢复用）
class Tab {
  constructor(net, id, persistedOps) {
    this.id = id;
    this.net = net;
    this.persisted = persistedOps || [];
    this.store = createStore({
      nodeId: id,
      persist: (op) => this.persisted.push(op),
    });
    if (this.persisted.length) this.store.loadOps(this.persisted);
    this.store.on('ops', (ops) => {
      for (const op of ops) net.send(id, { kind: 'ops', ops });
    });
    net.add(this);
  }
  receive(msg) { if (msg.kind === 'ops') this.store.applyRemote(msg.ops); }
  // 反熵：离线恢复后互相补齐缺失操作
  syncWith(others) {
    for (const o of others) {
      if (o.id === this.id) continue;
      const missing = o.store.missingOps(this.store.getVersionVector());
      if (missing.length) this.store.applyRemote(missing);
      const mine = this.store.missingOps(o.store.getVersionVector());
      if (mine.length) o.store.applyRemote(mine);
    }
  }
}

function boardState(store) {
  const cols = {};
  for (const col of ['todo', 'doing', 'done']) {
    cols[col] = store.sortedColumn(col).map((c) => c.id + '=' + c.title);
  }
  return JSON.stringify(cols);
}

function assertConverged(tabs, msg) {
  const ref = boardState(tabs[0].store);
  for (const t of tabs) assert.strictEqual(boardState(t.store), ref, msg + ' @' + t.id);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name); console.error(e); process.exitCode = 1; }
}

console.log('CRDT 核心测试');

// 1. 两个标签页并发拖拽同一卡片 -> 最终一致
test('两标签页拖拽同一卡片最终一致', () => {
  const net = new Network();
  const a = new Tab(net, 'tabA');
  const b = new Tab(net, 'tabB');
  const cardId = a.store.addCard('todo', '卡片1');
  net.run(200);
  assert.strictEqual(b.store.sortedColumn('todo').length, 1);
  // 并发移动（消息还在路上）
  a.store.moveCard(cardId, 'doing', 0);
  b.store.moveCard(cardId, 'done', 0);
  net.run(500);
  assertConverged([a, b], '并发移动收敛');
  const colA = a.store.getCard(cardId).col;
  assert.ok(colA === 'doing' || colA === 'done');
});

// 2. 4 个标签页并发操作 + 乱序 -> 全部一致
test('4标签页并发增删改移+消息乱序最终一致', () => {
  const net = new Network();
  const tabs = ['t1', 't2', 't3', 't4'].map((id) => new Tab(net, id));
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const t = tabs[i % 4];
    ids.push(t.store.addCard(['todo', 'doing', 'done'][i % 3], '卡' + i));
    if (i % 5 === 0) net.tick(5); // 部分投递，制造交错
  }
  net.run(300);
  // 并发移动/编辑/删除
  for (let i = 0; i < ids.length; i++) {
    const t = tabs[(i + 1) % 4];
    if (i % 7 === 0) t.store.deleteCard(ids[i]);
    else if (i % 3 === 0) t.store.moveCard(ids[i], ['todo', 'doing', 'done'][(i + 1) % 3], i % 4);
    else t.store.editCard(ids[i], '改' + i, '');
    if (i % 3 === 0) net.tick(3);
  }
  net.run(1000);
  assert.strictEqual(net.pending(), 0);
  assertConverged(tabs, '4标签页收敛');
});

// 3. 离线操作恢复后自动合并
test('离线操作恢复后合并正确', () => {
  const net = new Network();
  const a = new Tab(net, 'offA');
  const b = new Tab(net, 'offB');
  const c1 = a.store.addCard('todo', '在线卡');
  net.run(200);
  // a 离线
  net.partition(['offA']);
  const c2 = a.store.addCard('doing', '离线卡A'); // a 离线时的操作
  a.store.moveCard(c1, 'done', 0);
  const c3 = b.store.addCard('todo', '在线卡B'); // b 继续在线操作
  b.store.editCard(c1, '在线改名', '');
  net.run(300);
  // a 还没恢复，b 看不到 a 的离线操作
  assert.strictEqual(b.store.sortedColumn('doing').length, 0);
  // 恢复 + 反熵合并
  net.heal();
  a.syncWith([b]); b.syncWith([a]);
  net.run(300);
  a.syncWith([b]); b.syncWith([a]);
  assertConverged([a, b], '离线合并收敛');
  assert.ok(b.store.getCard(c2), '离线新增的卡合并到b');
  assert.strictEqual(b.store.getCard(c1).col, 'done', '离线移动生效');
  assert.strictEqual(b.store.getCard(c1).title, '在线改名', '在线编辑保留');
  assert.ok(b.store.getCard(c3));
});

// 4. 删除与编辑冲突：删除优先
test('删除与并发编辑冲突：删除获胜', () => {
  const net = new Network();
  const a = new Tab(net, 'delA');
  const b = new Tab(net, 'delB');
  const id = a.store.addCard('todo', '将被删');
  net.run(200);
  // 并发：a 删除，b 编辑（消息未投递）
  a.store.deleteCard(id);
  b.store.editCard(id, '并发编辑', '');
  net.run(500);
  assertConverged([a, b], '删编冲突收敛');
  assert.ok(a.store.getCard(id).deleted, 'a侧已删除');
  assert.ok(b.store.getCard(id).deleted, 'b侧删除优先');
  assert.strictEqual(b.store.sortedColumn('todo').length, 0);
});

// 5. 删除 vs 移动冲突：删除优先
test('删除与并发移动冲突：删除获胜', () => {
  const net = new Network();
  const a = new Tab(net, 'dmA');
  const b = new Tab(net, 'dmB');
  const id = a.store.addCard('todo', 'x');
  net.run(200);
  a.store.deleteCard(id);
  b.store.moveCard(id, 'done', 0);
  net.run(500);
  assertConverged([a, b], '删移冲突收敛');
  assert.ok(b.store.getCard(id).deleted);
});

// 6. 消息乱序不丢操作（DELETE 先于 ADD 到达）
test('消息乱序：删除先于新增到达仍收敛', () => {
  const net = new Network();
  const a = new Tab(net, 'ordA');
  const b = new Tab(net, 'ordB');
  const id = a.store.addCard('todo', '乱序卡');
  a.store.deleteCard(id);
  // 手动乱序投递：先投 DELETE 再投 ADD
  const ops = a.persisted.slice();
  b.store.applyRemote([ops[1], ops[0]]);
  assert.ok(b.store.getCard(id).deleted, '乱序下删除仍生效');
  assert.strictEqual(b.store.sortedColumn('todo').length, 0);
  net.run(200);
  assertConverged([a, b], '乱序收敛');
});

// 7. 刷新/重启不丢数据（从 IndexedDB 持久化日志恢复）
test('标签页关闭重开：从持久化日志恢复', () => {
  const net = new Network();
  const a = new Tab(net, 'reA');
  const b = new Tab(net, 'reB');
  const id = a.store.addCard('todo', '持久卡');
  net.run(200);
  b.store.editCard(id, '改后', '');
  net.run(200);
  const before = boardState(b.store);
  // b 关闭重开：用持久化日志重建
  const b2 = new Tab(net, 'reB2', b.persisted);
  assert.strictEqual(boardState(b2.store), before, '重启后状态一致');
});

// 8. 重复投递幂等
test('重复消息幂等', () => {
  const net = new Network();
  const a = new Tab(net, 'dupA');
  const b = new Tab(net, 'dupB');
  const id = a.store.addCard('todo', 'dup');
  net.run(200);
  b.store.applyRemote(a.persisted); // 重复投递全部
  b.store.applyRemote(a.persisted);
  assert.strictEqual(b.store.sortedColumn('todo').length, 1);
  assertConverged([a, b], '幂等收敛');
});

// 9. Logoot 位置：大量随机插入保持全序且唯一
test('Logoot 位置全序且唯一', () => {
  const positions = [];
  for (let i = 0; i < 500; i++) {
    const idx = Math.floor(Math.random() * (positions.length + 1));
    const pos = Logoot.atIndex(positions, idx, 'site' + (i % 3));
    positions.splice(idx, 0, pos);
    for (let j = 1; j < positions.length; j++) {
      assert.ok(Logoot.compare(positions[j - 1], positions[j]) < 0, '严格递增 i=' + i + ' j=' + j);
    }
  }
  const strs = new Set(positions.map(Logoot.toString));
  assert.strictEqual(strs.size, positions.length, '位置唯一');
});

// 10. HLC 全序
test('HLC 时间戳全序', () => {
  const h1 = HLC.create('a');
  const h2 = HLC.create('b');
  const stamps = [];
  for (let i = 0; i < 100; i++) {
    stamps.push(HLC.tick(h1));
    stamps.push(HLC.tick(h2));
    HLC.observe(h1, stamps[stamps.length - 1]);
  }
  const sorted = stamps.slice().sort(HLC.compare);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(HLC.compare(sorted[i - 1], sorted[i]) < 0, '无相等时间戳');
  }
});

console.log(passed + ' 个测试通过');
