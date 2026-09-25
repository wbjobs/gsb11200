/* 看板应用：UI 渲染 + Pointer Events 拖拽 + CRDT/同步/持久化装配 */
(function () {
  'use strict';

  const COLUMNS = [
    { id: 'todo', name: '待办' },
    { id: 'doing', name: '进行中' },
    { id: 'done', name: '已完成' },
  ];

  const nodeId = 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  let db = null;
  let store = null;
  let sync = null;
  let editingId = null;   // 正在编辑的卡片（编辑期间暂停重渲染，避免输入被打断）
  let drag = null;        // 拖拽状态
  let renderQueued = false;

  // ---------- 渲染 ----------
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    if (drag) return;       // 拖拽中不重渲染（松手后统一渲染）
    if (editingId) return;  // 编辑中不重渲染
    for (const col of COLUMNS) {
      const listEl = document.querySelector('.card-list[data-col="' + col.id + '"]');
      const cards = store.sortedColumn(col.id);
      listEl.textContent = '';
      for (const card of cards) listEl.appendChild(cardEl(card));
      const countEl = document.querySelector('.col-count[data-col="' + col.id + '"]');
      countEl.textContent = String(cards.length);
    }
  }

  function cardEl(card) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.cardId = card.id;

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = card.title || '(无标题)';
    el.appendChild(title);

    if (card.body) {
      const body = document.createElement('div');
      body.className = 'card-body';
      body.textContent = card.body;
      el.appendChild(body);
    }

    const del = document.createElement('button');
    del.className = 'card-del';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      store.deleteCard(card.id);
    });
    el.appendChild(del);

    el.addEventListener('dblclick', () => startEdit(card.id));
    el.addEventListener('pointerdown', (e) => onCardPointerDown(e, card.id));
    return el;
  }

  // ---------- 编辑 ----------
  function startEdit(cardId) {
    const card = store.getCard(cardId);
    if (!card || card.deleted || editingId) return;
    editingId = cardId;
    const el = document.querySelector('.card[data-card-id="' + CSS.escape(cardId) + '"]');
    if (!el) { editingId = null; return; }
    el.textContent = '';
    el.classList.add('editing');

    const titleInput = document.createElement('input');
    titleInput.className = 'edit-title';
    titleInput.value = card.title || '';
    titleInput.placeholder = '标题';
    const bodyInput = document.createElement('textarea');
    bodyInput.className = 'edit-body';
    bodyInput.value = card.body || '';
    bodyInput.placeholder = '描述（可选）';
    const hint = document.createElement('div');
    hint.className = 'edit-hint';
    hint.textContent = 'Ctrl+Enter 保存 · Esc 取消';
    el.appendChild(titleInput);
    el.appendChild(bodyInput);
    el.appendChild(hint);
    titleInput.focus();
    titleInput.select();

    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      editingId = null;
      if (save) store.editCard(cardId, titleInput.value.trim() || '(无标题)', bodyInput.value.trim());
      render();
    }
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    bodyInput.addEventListener('blur', () => setTimeout(() => {
      if (!el.contains(document.activeElement)) finish(true);
    }, 0));
    titleInput.addEventListener('blur', () => setTimeout(() => {
      if (!el.contains(document.activeElement)) finish(true);
    }, 0));
  }

  // ---------- 拖拽（Pointer Events）----------
  function onCardPointerDown(e, cardId) {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, textarea')) return;
    if (editingId) return;
    const startX = e.clientX, startY = e.clientY;
    const srcEl = e.currentTarget;
    let started = false;

    function onMove(ev) {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = beginDrag(srcEl, cardId, ev);
        if (!started) { cleanup(); return; }
      }
      updateDrag(ev);
    }
    function onUp(ev) {
      if (started) endDrag(ev);
      cleanup();
    }
    function cleanup() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function beginDrag(srcEl, cardId, ev) {
    const card = store.getCard(cardId);
    if (!card || card.deleted) return false;
    const rect = srcEl.getBoundingClientRect();
    const ghost = srcEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.left = '0';
    ghost.style.top = '0';
    document.body.appendChild(ghost);
    srcEl.classList.add('drag-src');

    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';

    drag = {
      cardId, ghost, indicator, srcEl,
      offX: ev.clientX - rect.left,
      offY: ev.clientY - rect.top,
      target: null,
    };
    moveGhost(ev);
    return true;
  }

  function moveGhost(ev) {
    drag.ghost.style.transform =
      'translate(' + (ev.clientX - drag.offX) + 'px,' + (ev.clientY - drag.offY) + 'px) rotate(2deg)';
  }

  function updateDrag(ev) {
    if (!drag) return;
    moveGhost(ev);
    // 命中列
    let colEl = null;
    for (const el of document.querySelectorAll('.column')) {
      const r = el.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        colEl = el;
        break;
      }
    }
    if (!colEl) return; // 在列间隙：保留上一个目标
    const listEl = colEl.querySelector('.card-list');
    const col = listEl.dataset.col;
    // 计算插入位置（排除被拖卡片本身）
    const cards = Array.from(listEl.querySelectorAll('.card:not(.drag-src)'));
    let index = cards.length;
    let beforeEl = null;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { index = i; beforeEl = cards[i]; break; }
    }
    if (beforeEl) listEl.insertBefore(drag.indicator, beforeEl);
    else listEl.appendChild(drag.indicator);
    drag.target = { col, index };
    // 边缘自动滚动
    const lr = listEl.getBoundingClientRect();
    if (ev.clientY < lr.top + 40) listEl.scrollTop -= 12;
    else if (ev.clientY > lr.bottom - 40) listEl.scrollTop += 12;
  }

  function endDrag() {
    if (!drag) return;
    const target = drag.target;
    const cardId = drag.cardId;
    cleanupDrag();
    if (target) store.moveCard(cardId, target.col, target.index);
    render();
  }

  function abortDrag() {
    if (!drag) return;
    cleanupDrag();
    render();
  }

  function cleanupDrag() {
    drag.ghost.remove();
    drag.indicator.remove();
    drag.srcEl.classList.remove('drag-src');
    drag = null;
  }

  // ---------- 状态栏 ----------
  function renderStatus() {
    document.getElementById('node-id').textContent = nodeId.slice(0, 12) + '…';
    const peers = sync.peers();
    document.getElementById('peer-count').textContent = String(peers.length + 1);
    const rtts = peers.map((p) => p.rtt).filter((x) => x != null);
    document.getElementById('latency').textContent =
      rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) + 'ms' : '—';
  }

  function setOnlineUI(online) {
    const btn = document.getElementById('btn-offline');
    btn.textContent = online ? '模拟离线' : '恢复在线';
    btn.classList.toggle('warn', !online);
    document.getElementById('net-state').textContent = online ? '在线' : '离线（操作已持久化，恢复后自动合并）';
    document.getElementById('net-state').className = online ? 'ok' : 'bad';
  }

  // ---------- 启动 ----------
  async function boot() {
    db = await KanbanDB.open();
    const ops = await KanbanDB.getAllOps(db);

    store = CRDTStore.createStore({
      nodeId,
      persist: (op) => { KanbanDB.putOp(db, op).catch(console.error); },
    });
    store.loadOps(ops);

    // 首次使用：写入示例卡片（localStorage 防止多标签页重复播种）
    if (ops.length === 0 && !localStorage.getItem('kanban-seeded')) {
      localStorage.setItem('kanban-seeded', '1');
      const a = store.addCard('todo', '欢迎使用 CRDT 看板', '双击编辑我，或把我拖到其他列');
      store.addCard('todo', '再开几个标签页试试', '所有标签页实时同步');
      store.addCard('doing', '离线也能用', '点右上角「模拟离线」，操作后恢复，自动合并');
      store.moveCard(a, 'todo', 2);
    }

    sync = KanbanSync.createSync({
      store,
      channelName: 'crdt-kanban-v1',
      loadPersisted: () => KanbanDB.getAllOps(db),
    });

    store.on('change', () => {
      // 拖拽中被删：中止拖拽
      if (drag) {
        const c = store.getCard(drag.cardId);
        if (!c || c.deleted) { abortDrag(); return; }
        return; // 拖拽中延迟渲染
      }
      if (editingId) {
        const c = store.getCard(editingId);
        if (!c || c.deleted) { editingId = null; render(); }
        return; // 编辑中延迟渲染
      }
      scheduleRender();
    });
    sync.on('peers', renderStatus);
    sync.on('latency', renderStatus);
    sync.on('online', setOnlineUI);

    // 界面事件
    for (const col of COLUMNS) {
      document.querySelector('.btn-add[data-col="' + col.id + '"]').addEventListener('click', () => {
        const id = store.addCard(col.id, '新卡片', '');
        render();
        startEdit(id);
      });
    }
    document.getElementById('btn-new-tab').addEventListener('click', () => {
      window.open(location.href, '_blank');
    });
    document.getElementById('btn-offline').addEventListener('click', () => {
      sync.setOnline(!sync.isOnline());
    });
    document.getElementById('btn-clear').addEventListener('click', async () => {
      if (!confirm('清空本机 IndexedDB 数据并刷新？（其他在线标签页可能会把数据同步回来）')) return;
      await KanbanDB.clearAll(db);
      localStorage.removeItem('kanban-seeded');
      location.reload();
    });
    window.addEventListener('online', () => sync.setOnline(true));
    window.addEventListener('offline', () => sync.setOnline(false));

    setInterval(renderStatus, 2000);
    setOnlineUI(true);
    renderStatus();
    render();
  }

  boot().catch((e) => {
    console.error(e);
    document.body.innerHTML = '<p style="padding:2rem">初始化失败：' + e.message + '</p>';
  });
})();
