// dom-ui.js - Small DOM UI helpers shared across extension pages. Keep this
// free of page-specific state so popup and dashboard can both use it.

// Briefly swap a button's label to confirm an action (e.g. a clipboard write),
// then restore the original text. `ms` lets a caller match a shorter flash.
export function flashButton(btn, msg, ms = 1500) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => {
    btn.textContent = orig;
  }, ms);
}

// Vertical resize for JSON textareas. Expects
// `<div class="resizable"><textarea>…</textarea><span class="resize-handle"></span></div>`.
// The native grip is disabled in CSS (resize:none) so the handle matches the
// dashboard theme; this only drives the height, width stays 100%.
export function wireResizable(root = document) {
  root.querySelectorAll(".resizable").forEach((box) => {
    if (box.dataset.resizableWired) return;
    const ta = box.querySelector("textarea");
    const handle = box.querySelector(".resize-handle");
    if (!ta || !handle) return;
    box.dataset.resizableWired = "1";

    let startY = 0;
    let startH = 0;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = ta.getBoundingClientRect().height;
      handle.setPointerCapture(e.pointerId);
      box.classList.add("resizing");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const min = parseFloat(getComputedStyle(ta).minHeight) || 0;
      const next = Math.max(min, startH + (e.clientY - startY));
      ta.style.height = `${Math.round(next)}px`;
    });
    const end = (e) => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      box.classList.remove("resizing");
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}
