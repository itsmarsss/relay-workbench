// Native dragging keeps ordinary card clicks and text selection predictable.
export function installBoardDrag({ onDrag, onMove, onChoose }) {
  let dragged = null,
    board = null,
    target = null,
    frame = null,
    velocity = 0,
    suppressUntil = 0;
  const highlight = (column) => {
    if (target === column) return;
    target?.classList.remove('is-drop-target');
    target = column;
    target?.classList.add('is-drop-target');
  };
  const clean = () => {
    const active = dragged;
    dragged = null;
    document.querySelector('.board-card.is-dragging')?.classList.remove('is-dragging');
    board?.classList.remove('is-dragging');
    highlight(null);
    cancelAnimationFrame(frame);
    frame = null;
    velocity = 0;
    board = null;
    if (active) {
      suppressUntil = Date.now() + 350;
      onDrag(false);
    }
  };
  document.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.board-card');
    if (!card || !event.dataTransfer) return;
    dragged = { id: card.dataset.id, lane: card.closest('.board-column').dataset.lane };
    board = card.closest('.workflow-board');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged.id);
    onDrag(true);
    // Delay styling until the browser captures the card's drag image.
    requestAnimationFrame(() => {
      if (dragged) {
        const left = card.getBoundingClientRect().left;
        card.classList.add('is-dragging');
        board?.classList.add('is-dragging');
        if (board) board.scrollLeft += card.getBoundingClientRect().left - left;
      }
    });
    const scroll = () => {
      if (!dragged || !board) return;
      board.scrollLeft += velocity;
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
  });
  document.addEventListener('dragover', (event) => {
    if (!dragged) return;
    const column = event.target.closest('.board-column');
    if (!column || column.closest('.workflow-board') !== board) {
      highlight(null);
      velocity = 0;
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    highlight(column);
    const rect = board.getBoundingClientRect();
    const right = Math.min(rect.right, innerWidth),
      left = Math.max(rect.left, 0);
    velocity = event.clientX > right - 55 ? 14 : event.clientX < left + 55 ? -14 : 0;
  });
  document.addEventListener('drop', (event) => {
    if (!dragged) return;
    const column = event.target.closest('.board-column');
    if (!column || column.closest('.workflow-board') !== board) {
      clean();
      return;
    }
    event.preventDefault();
    const move = { id: dragged.id, from: dragged.lane, to: column.dataset.lane };
    // Start the mutation before releasing the rendering lock.
    if (move.from !== move.to) onMove(move.id, move.to);
    clean();
  });
  document.addEventListener('dragend', clean);
  document.addEventListener('keydown', (event) => {
    const card = event.target.closest('.board-card');
    if (
      card &&
      event.key.toLowerCase() === 'm' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      onChoose(card.dataset.id);
    }
    if (event.key === 'Escape') clean();
  });
  document.addEventListener(
    'click',
    (event) => {
      if (Date.now() < suppressUntil && event.target.closest('.board-card')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener('blur', clean);
}
