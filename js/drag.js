// 基于 Pointer Events 的拖拽：列内排序 + 跨列移动，带插入占位符。

const THRESHOLD = 6;

export function enableDrag(boardEl, { onDrop, onDragEnd }) {
  let drag = null;

  boardEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    if (e.target.closest('button, input, textarea, a')) return;
    const card = e.target.closest('.card');
    if (!card) return;
    drag = {
      pointerId: e.pointerId,
      card,
      cardId: card.dataset.id,
      x: e.clientX,
      y: e.clientY,
      active: false,
      ghost: null,
      placeholder: null,
      offsetX: 0,
      offsetY: 0,
    };
  });

  boardEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < THRESHOLD) return;
      activate(e);
    }
    e.preventDefault();
    positionGhost(e);
    updatePlaceholder(e);
  });

  boardEl.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    finish(true);
  });

  boardEl.addEventListener('pointercancel', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    finish(false);
  });

  function activate(e) {
    const { card } = drag;
    drag.active = true;
    try {
      card.setPointerCapture(e.pointerId);
    } catch (_) {}
    const rect = card.getBoundingClientRect();
    drag.offsetX = drag.x - rect.left;
    drag.offsetY = drag.y - rect.top;

    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);
    drag.ghost = ghost;

    const placeholder = document.createElement('div');
    placeholder.className = 'drop-placeholder';
    placeholder.style.height = `${rect.height}px`;
    card.after(placeholder);
    card.classList.add('drag-source');
    positionGhost(e);
  }

  function positionGhost(e) {
    drag.ghost.style.transform =
      `translate(${e.clientX - drag.offsetX}px, ${e.clientY - drag.offsetY}px) rotate(3deg)`;
  }

  function updatePlaceholder(e) {
    const columns = [...boardEl.querySelectorAll('.column')];
    let columnEl = null;
    for (const col of columns) {
      const r = col.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        columnEl = col;
        break;
      }
    }
    if (!columnEl) {
      let best = Infinity;
      for (const col of columns) {
        const r = col.getBoundingClientRect();
        const d = Math.abs(e.clientX - (r.left + r.width / 2));
        if (d < best) {
          best = d;
          columnEl = col;
        }
      }
    }
    const list = columnEl.querySelector('.card-list');
    const cards = [...list.querySelectorAll('.card:not(.drag-source)')];
    let before = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        before = c;
        break;
      }
    }
    if (before) list.insertBefore(drag.placeholder, before);
    else list.appendChild(drag.placeholder);
  }

  function finish(commit) {
    const d = drag;
    drag = null;
    if (!d.active) return;

    let result = null;
    if (commit && d.placeholder.parentElement) {
      const list = d.placeholder.parentElement;
      const column = list.dataset.column;
      let index = 0;
      for (const el of list.children) {
        if (el === d.placeholder) break;
        if (el.classList.contains('card') && !el.classList.contains('drag-source')) index += 1;
      }
      result = { cardId: d.cardId, column, index };
    }

    d.ghost.remove();
    d.placeholder.remove();
    d.card.classList.remove('drag-source');

    if (result) onDrop(result);
    if (onDragEnd) onDragEnd();
  }

  return {
    isDragging: () => !!(drag && drag.active),
  };
}
