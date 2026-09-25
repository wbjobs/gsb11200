import { CRDTStore } from './crdt.js';
import { generateKeyBetween } from './fractional.js';
import { openDB } from './db.js';
import { SyncEngine } from './sync.js';
import { enableDrag } from './drag.js';

const COLUMNS = ['todo', 'doing', 'done'];

const clientId = crypto.randomUUID().slice(0, 8);
const store = new CRDTStore(clientId);
const db = await openDB();
store.applyOps(await db.getAllOps());

const channel = new BroadcastChannel('kanban-crdt-v1');
const boardEl = document.getElementById('board');

let renderQueued = false;

const drag = enableDrag(boardEl, {
  onDrop: handleDrop,
  onDragEnd: () => {
    if (renderQueued) {
      renderQueued = false;
      render();
    }
  },
});

const sync = new SyncEngine({
  store,
  db,
  channel,
  onChange: requestRender,
  onPresence: renderPresence,
});

if (store.log.length === 0) seed();
sync.start();
render();
updateNetStatus();
document.getElementById('tab-id').textContent = `标签 ${clientId}`;

function seed() {
  const seeds = [
    ['seed-1', '欢迎使用协同看板', '拖动卡片可在列内排序、跨列移动', 'todo'],
    ['seed-2', '多开几个标签页', '所有操作通过 BroadcastChannel 实时同步', 'todo'],
    ['seed-3', '试试模拟离线', '离线操作会缓存，恢复在线后自动合并', 'doing'],
    ['seed-4', '刷新不丢数据', '操作日志持久化在 IndexedDB', 'done'],
  ];
  const lastKey = {};
  for (const [cardId, title, desc, column] of seeds) {
    const posKey = generateKeyBetween(lastKey[column] ?? null, null);
    lastKey[column] = posKey;
    sync.localOp(store.createCard({ cardId, title, desc, column, posKey }));
  }
}

function handleDrop({ cardId, column, index }) {
  const cards = store.visibleCards(column).filter((c) => c.id !== cardId);
  const clamped = Math.max(0, Math.min(index, cards.length));
  let prevKey = clamped > 0 ? cards[clamped - 1].posKey : null;
  const nextKey = clamped < cards.length ? cards[clamped].posKey : null;
  if (prevKey !== null && nextKey !== null && prevKey >= nextKey) {
    prevKey = null;
    for (let i = clamped - 1; i >= 0; i -= 1) {
      if (cards[i].posKey < nextKey) {
        prevKey = cards[i].posKey;
        break;
      }
    }
  }
  const posKey = generateKeyBetween(prevKey, nextKey);
  const card = store.cards.get(cardId);
  if (!card || card.deleted) return;
  if (card.column === column && card.posKey === posKey) return;
  sync.localOp(store.moveCard(cardId, column, posKey));
}

function requestRender() {
  if (drag.isDragging()) {
    renderQueued = true;
    return;
  }
  render();
}

function render() {
  for (const col of COLUMNS) {
    const listEl = document.querySelector(`.card-list[data-column="${col}"]`);
    const cards = store.visibleCards(col);
    listEl.replaceChildren(...cards.map(renderCard));
    document.querySelector(`.column[data-column="${col}"] .count`).textContent = cards.length;
  }
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = card.title;
  el.appendChild(title);

  if (card.desc) {
    const desc = document.createElement('div');
    desc.className = 'card-desc';
    desc.textContent = card.desc;
    el.appendChild(desc);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = '✎ 编辑';
  editBtn.addEventListener('click', () => openModal(card));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'danger';
  delBtn.textContent = '🗑 删除';
  delBtn.addEventListener('click', () => {
    if (window.confirm(`删除卡片「${card.title}」？`)) {
      sync.localOp(store.deleteCard(card.id));
    }
  });

  actions.append(editBtn, delBtn);
  el.appendChild(actions);
  return el;
}

const modal = document.getElementById('modal');
const form = document.getElementById('card-form');
const fieldTitle = document.getElementById('field-title');
const fieldDesc = document.getElementById('field-desc');
let editingCard = null;
let targetColumn = null;

function openModal(card, column) {
  editingCard = card || null;
  targetColumn = column || (card && card.column) || null;
  document.getElementById('modal-title').textContent = card ? '编辑卡片' : '新建卡片';
  fieldTitle.value = card ? card.title : '';
  fieldDesc.value = card ? card.desc : '';
  modal.hidden = false;
  fieldTitle.focus();
}

function closeModal() {
  modal.hidden = true;
  editingCard = null;
  targetColumn = null;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = fieldTitle.value.trim();
  const desc = fieldDesc.value.trim();
  if (!title) return;
  if (editingCard) {
    if (!editingCard.deleted) {
      sync.localOp(store.editCard(editingCard.id, { title, desc }));
    }
  } else if (targetColumn) {
    const cards = store.visibleCards(targetColumn);
    const posKey = generateKeyBetween(cards.length ? cards[cards.length - 1].posKey : null, null);
    sync.localOp(store.createCard({ cardId: crypto.randomUUID(), title, desc, column: targetColumn, posKey }));
  }
  closeModal();
});

document.getElementById('modal-cancel').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

for (const btn of document.querySelectorAll('.add-card')) {
  btn.addEventListener('click', () => openModal(null, btn.dataset.column));
}

document.getElementById('toggle-offline').addEventListener('click', () => {
  sync.setOnline(!sync.online);
  updateNetStatus();
});

document.getElementById('resync').addEventListener('click', () => {
  sync.requestSync();
});

function updateNetStatus() {
  const el = document.getElementById('net-status');
  el.textContent = sync.online ? '在线' : '离线（操作已缓存）';
  el.classList.toggle('online', sync.online);
  el.classList.toggle('offline', !sync.online);
  document.getElementById('toggle-offline').textContent = sync.online ? '模拟离线' : '恢复在线';
}

function renderPresence(peerCount) {
  document.getElementById('presence').textContent = `标签页: ${peerCount + 1}`;
}

window.addEventListener('pagehide', () => {
  channel.postMessage({ kind: 'presence-bye', from: clientId });
});
window.addEventListener('pageshow', () => {
  channel.postMessage({ kind: 'presence-hello', from: clientId });
});
