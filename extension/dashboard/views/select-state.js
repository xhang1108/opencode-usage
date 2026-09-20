// extension/dashboard/views/select-state.js
// The selection state behind the styled dropdowns (filter bar, Settings →
// General, the peak-model picker). Pure: no DOM, no chrome.
//
// Two ideas are kept apart:
//   * `all` is the visual "every box is checked" state — the default, and what
//     `Select All` restores.
//   * `selected` is a proper, non-everything subset of the options.
//
// A caller reads "no filter" as an empty `getSelected()`, and both ends of the
// spectrum collapse to it: everything checked (`all`) or nothing checked (empty
// `selected`). `Clear` unchecks every box and lands in the latter state, so it
// never re-checks anything.

export function createSelectState({ optionValues, allLabel = "All", labelFor = (v) => v }) {
  const values = () => (typeof optionValues === "function" ? optionValues() : optionValues || []);
  let all = true;
  let selected = new Set();

  function setSelected(list) {
    if (!list || list.length === 0) {
      all = true;
      selected.clear();
    } else {
      all = false;
      selected = new Set(list);
    }
  }

  function toggle(value) {
    const cur = all ? new Set(values()) : new Set(selected);
    if (cur.has(value)) cur.delete(value);
    else cur.add(value);
    // Checking every value collapses to `all`; unchecking every value is its
    // own state (nothing checked), not `all`, so the boxes stay clear.
    if (cur.size === values().length) {
      all = true;
      selected.clear();
    } else {
      all = false;
      selected = cur;
    }
  }

  function multiLabel() {
    if (all || selected.size === 0) return allLabel;
    if (selected.size === 1) return labelFor(Array.from(selected)[0]);
    return `${selected.size} selected`;
  }

  return {
    isAll: () => all,
    isChecked: (value) => all || selected.has(value),
    getSelected: () => (all ? [] : Array.from(selected)),
    setSelected,
    toggle,
    selectAll() {
      all = true;
      selected.clear();
    },
    // Clear unchecks everything: no boxes selected, and `getSelected()` is
    // empty (no filter). It must not fall back to "all checked".
    clear() {
      all = false;
      selected.clear();
    },
    multiLabel,
  };
}
