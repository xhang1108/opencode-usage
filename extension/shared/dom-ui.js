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
