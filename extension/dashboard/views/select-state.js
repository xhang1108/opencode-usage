// extension/dashboard/views/select-state.js
// The selection state behind the styled dropdowns (filter bar, Settings →
// General, the peak-model picker). "All" is represented as an empty selection so
// a caller can treat `[]` as "no filter". Pure: no DOM, no chrome.
//
// Invariant: an empty selection IS "all". Unchecking the last value, clearing,
// or passing an empty list all collapse back to `all`, so the checkboxes and the
// label can never disagree with what the caller filters on.

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
    // Collapse to `all` both when everything is checked and when nothing is: an
    // empty selection means "no filter", so it must read as all.
    if (cur.size === values().length || cur.size === 0) {
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
    // Clear = uncheck everything = "no filter" = all (see the invariant above).
    clear() {
      all = true;
      selected.clear();
    },
    multiLabel,
  };
}
