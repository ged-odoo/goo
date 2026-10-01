// Pointer-based row drag-and-drop, shared by every reorderable list (todos,
// config list editors, tabs, navbar links). Not HTML5 dnd: its "drag image"
// is a static snapshot of whatever was draggable (usually the tiny ⠿ handle),
// so nothing visibly moves. Here the grabbed row lifts into a fixed-position
// clone — the ghost — that follows the cursor; the consumer drives its own
// targeting/reordering from the move callback.

// Start a drag from a pointerdown event. Options:
// - row: the element to lift (the ghost is its clone, width pinned)
// - onMove(ev): every pointermove (and once at start) — compute the target /
//   live-reorder there
// - onEnd(commit): drag finished — true on drop, false on Escape/cancel
// Returns a stop(commit) handle (call it from onWillUnmount so a mid-drag
// unmount never leaks the ghost or the window listeners), or null when the
// event isn't a plain left-button press.
export function startRowDrag(ev, { row, onMove, onEnd }) {
  if (ev.button !== 0 || !row) return null;
  ev.preventDefault(); // no text selection while dragging
  const rect = row.getBoundingClientRect();
  const offsetX = ev.clientX - rect.left;
  const offsetY = ev.clientY - rect.top;
  const ghost = row.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.classList.remove("dragging", "drag-over");
  ghost.style.width = `${rect.width}px`;
  // cloneNode copies attributes, not live input state — sync typed values so
  // the ghost shows what the row shows
  const src = row.querySelectorAll("input, select, textarea");
  ghost.querySelectorAll("input, select, textarea").forEach((el, i) => {
    if (!src[i]) return;
    el.value = src[i].value;
    el.checked = src[i].checked;
  });
  document.body.appendChild(ghost);
  // positioned via the `translate` property, not `transform`: the individual
  // transform properties compose as translate → rotate → scale → transform, so a
  // ghost that also carries a CSS rotate/scale (the kanban card's lift) would
  // rotate and scale the offset itself if it were written to `transform`, and
  // the card would slide away from the cursor as the drag got longer.
  const place = (e) => {
    ghost.style.translate = `${e.clientX - offsetX}px ${e.clientY - offsetY}px`;
  };
  const move = (e) => {
    place(e);
    onMove(e);
  };
  const stop = (commit) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key);
    document.body.classList.remove("drag-grabbing");
    ghost.remove();
    onEnd(commit);
  };
  const up = () => stop(true);
  const cancel = () => stop(false);
  const key = (e) => e.key === "Escape" && stop(false);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key);
  document.body.classList.add("drag-grabbing");
  place(ev);
  onMove(ev);
  return stop;
}

// The index at which the pointer would insert among `rows` — the list's row
// elements WITHOUT the dragged one (its dimmed placeholder must not be its own
// target): the first row whose vertical midline is below the pointer, else
// after the last. With the dragged row excluded, this is also the right splice
// index in the array-without-it.
export function dropIndex(ev, rows) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (ev.clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}
