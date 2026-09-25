/* 同步层集成测试：Node 22 全局 BroadcastChannel 模拟 4 个标签页 */
'use strict';
const assert = require('assert');
const { createStore } = require('../js/crdt-store.js');
const { createSync } = require('../js/sync.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTab(id, persisted, sharedPersisted) {
  const store = createStore({
    nodeId: id,
    persist: (op) => persisted.push(op),
  });
  if (persisted.length) store.loadOps(persisted);
  const sync = createSync({
    store,
    channelName: 'test-kanban-' + process.pid,
    // 模拟共享 IndexedDB：所有标签页读写同一个数组
    loadPersisted: sharedPersisted ? async () => sharedPersisted : undefined,
  });
  return { id, store, sync, persisted };
}

function boardState(store) {
  const cols = {};
  for (const col of ['todo', 'doing', 'done']) {
    cols[col] = store.sortedColumn(col).map((c) => c.id + '=' + c.title);
  }
  return JSON.stringify(cols);
}

async function waitConverged(tabs, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ref = boardState(tabs[0].store);
    if (tabs.every((t) => boardState(t.store) === ref)) return;
    await sleep(25);
  }
  const ref = boardState(tabs[0].store);
  for (const t of tabs) assert.strictEqual(boardState(t.store), ref, label + ' @' + t.id);
}

async function main() {
  let passed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.error('  ✗ ' + name); console.error(e); process.exitCode = 1; }
  }

  console.log('同步层集成测试（BroadcastChannel）');

  await test('4标签页实时同步且延迟 < 200ms', async () => {
    const tabs = [1, 2, 3, 4].map((i) => makeTab('syncT' + i, []));
    await sleep(300); // 互相发现
    assert.strictEqual(tabs[0].sync.peers().length, 3, '发现3个对等节点');
    const t0 = Date.now();
    const id = tabs[0].store.addCard('todo', '实时卡');
    const deadline = t0 + 200;
    for (const t of tabs.slice(1)) {
      while (!t.store.getCard(id) && Date.now() < deadline) await sleep(5);
      assert.ok(t.store.getCard(id), t.id + ' 在200ms内收到');
      assert.ok(Date.now() - t0 < 200, '延迟<200ms，实际 ' + (Date.now() - t0) + 'ms');
    }
    console.log('    同步延迟约 ' + (Date.now() - t0) + 'ms');
    await waitConverged(tabs, 1000, '实时同步收敛');
    tabs.forEach((t) => t.sync.close());
  });

  await test('两标签页并发拖拽同一卡片最终一致', async () => {
    const tabs = [1, 2].map((i) => makeTab('dragT' + i, []));
    await sleep(300);
    const id = tabs[0].store.addCard('todo', '争夺卡');
    await sleep(200);
    // 并发移动（彼此尚未收到对方操作）
    tabs[0].store.moveCard(id, 'doing', 0);
    tabs[1].store.moveCard(id, 'done', 0);
    await waitConverged(tabs, 2000, '并发拖拽收敛');
    const col = tabs[0].store.getCard(id).col;
    assert.ok(col === 'doing' || col === 'done');
    tabs.forEach((t) => t.sync.close());
  });

  await test('离线操作恢复后自动合并', async () => {
    const tabs = [1, 2].map((i) => makeTab('offT' + i, []));
    await sleep(300);
    const c1 = tabs[0].store.addCard('todo', '在线卡');
    await sleep(200);
    // tab2 离线
    tabs[1].sync.setOnline(false);
    const c2 = tabs[1].store.addCard('doing', '离线卡');   // 离线新增
    tabs[1].store.moveCard(c1, 'done', 0);                 // 离线移动
    tabs[0].store.editCard(c1, '在线改名');                // 在线编辑
    tabs[0].store.addCard('todo', '对方在线卡');
    await sleep(300);
    assert.ok(!tabs[0].store.getCard(c2), '离线期间收不到');
    // 恢复在线 -> 自动反熵合并
    tabs[1].sync.setOnline(true);
    await waitConverged(tabs, 3000, '离线恢复合并');
    assert.ok(tabs[0].store.getCard(c2), '离线新增已合并');
    assert.strictEqual(tabs[0].store.getCard(c1).col, 'done');
    assert.strictEqual(tabs[0].store.getCard(c1).title, '在线改名');
    tabs.forEach((t) => t.sync.close());
  });

  await test('删除与编辑冲突正确解决（删除优先）', async () => {
    const tabs = [1, 2].map((i) => makeTab('delT' + i, []));
    await sleep(300);
    const id = tabs[0].store.addCard('todo', '冲突卡');
    await sleep(200);
    tabs[0].store.deleteCard(id);
    tabs[1].store.editCard(id, '并发编辑');
    await waitConverged(tabs, 2000, '删编冲突收敛');
    assert.ok(tabs[1].store.getCard(id).deleted, '删除优先');
    assert.strictEqual(tabs[1].store.sortedColumn('todo').length, 0);
    tabs.forEach((t) => t.sync.close());
  });

  await test('标签页关闭后重开：持久化恢复 + 反熵补齐', async () => {
    const persistedA = [], persistedB = [];
    const a = makeTab('closeA', persistedA);
    let b = makeTab('closeB', persistedB);
    await sleep(300);
    const id = a.store.addCard('todo', '关闭前');
    await sleep(200);
    b.sync.close(); // b 关闭
    a.store.editCard(id, '关闭期间的编辑'); // b 错过此操作
    a.store.addCard('doing', '关闭期间新增');
    await sleep(100);
    // b 重开：从 IndexedDB（persistedB）恢复 —— 模拟刷新：持久化里有关闭前的数据
    b = makeTab('closeB2', persistedB);
    assert.ok(b.store.getCard(id), '持久化恢复旧数据');
    await waitConverged([a, b], 3000, '重开后反熵补齐');
    assert.strictEqual(b.store.getCard(id).title, '关闭期间的编辑', '错过操作已补齐');
    a.sync.close();
    b.sync.close();
  });

  await test('标签页离线操作后直接关闭：共享存储反熵兜底', async () => {
    const shared = []; // 共享 IndexedDB
    const a = makeTab('goneA', [], shared);
    const b = makeTab('stayB', [], shared);
    await sleep(300);
    a.sync.setOnline(false);
    const id = a.store.addCard('todo', '离线后关闭的卡');
    shared.push(...a.persisted); // 操作写入共享 IndexedDB（persist 回调）
    a.sync.close();              // 直接关闭，不再上线
    await sleep(100);
    assert.ok(!b.store.getCard(id), '关闭前未收到');
    // b 的下一次心跳轮询共享存储（心跳2s），应捡到该操作
    const deadline = Date.now() + 4000;
    while (!b.store.getCard(id) && Date.now() < deadline) await sleep(50);
    assert.ok(b.store.getCard(id), '通过共享存储反熵获得离线关闭标签页的操作');
    b.sync.close();
  });

  await test('随机压力：4标签页 + 随机离线 + 乱序，最终一致', async () => {
    const tabs = [1, 2, 3, 4].map((i) => makeTab('soakT' + i, []));
    await sleep(300);
    const ids = [];
    for (let round = 0; round < 30; round++) {
      const t = tabs[Math.floor(Math.random() * 4)];
      const r = Math.random();
      if (r < 0.3 || ids.length === 0) {
        ids.push(t.store.addCard(['todo', 'doing', 'done'][round % 3], '卡' + round));
      } else {
        const id = ids[Math.floor(Math.random() * ids.length)];
        if (r < 0.5) t.store.moveCard(id, ['todo', 'doing', 'done'][Math.floor(Math.random() * 3)], Math.floor(Math.random() * 3));
        else if (r < 0.8) t.store.editCard(id, '改' + round);
        else t.store.deleteCard(id);
      }
      if (Math.random() < 0.2) { // 随机离线/恢复
        const unlucky = tabs[Math.floor(Math.random() * 4)];
        unlucky.sync.setOnline(false);
        setTimeout(() => unlucky.sync.setOnline(true), 100 + Math.random() * 200);
      }
      await sleep(20);
    }
    await sleep(1500);
    await waitConverged(tabs, 5000, '压力测试收敛');
    tabs.forEach((t) => t.sync.close());
  });

  console.log(passed + ' 个测试通过');
  process.exit(process.exitCode || 0);
}

main();
