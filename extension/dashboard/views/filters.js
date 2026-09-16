// extension/dashboard/views/filters.js
// Filter bar: custom workspace/model dropdowns and the custom date-range
// picker. State lives in the closure; callers supply records and a change hook.

import { todayISO } from "../core/time.js";
import { createSelectState } from "./select-state.js";
import { presetRange, pickRangeDay, dateBounds, rangeLabel } from "../core/date-range.js";

// Mirrors a hidden native <select> (source of truth for options) into a styled
// popup. In single mode it behaves like a native select; in `multi` mode it
// renders checkboxes so several values can be chosen at once. Selection state
// lives here: `getSelected()` returns `[]` (empty == all) or the chosen values.
export function initCustomSelect(selectId, triggerId, labelId, panelId, optionsId, opts = {}) {
  const { multi = false, allLabel = "All", labelFor = (v) => v } = opts;
  const select = document.getElementById(selectId);
  const trigger = document.getElementById(triggerId);
  const label = document.getElementById(labelId);
  const panel = document.getElementById(panelId);
  const optionsEl = document.getElementById(optionsId);

  // `all` true means "no filter"; `selected` holds explicit values otherwise.
  const optionValues = () => Array.from(select.options).map((o) => o.value);
  const state = createSelectState({ optionValues, allLabel, labelFor });

  function getSelected() {
    return state.getSelected();
  }

  function setSelected(values) {
    state.setSelected(values);
    updateLabel();
  }

  function updateLabel() {
    // Single mode mirrors the native <select> so it can be reused anywhere a
    // plain select was used; multi mode summarizes the checkbox set.
    if (!multi) {
      const opt = Array.from(select.options).find((o) => o.value === select.value);
      label.textContent = opt ? opt.textContent : allLabel;
      return;
    }
    label.textContent = state.multiLabel();
  }

  function toggleValue(value) {
    state.toggle(value);
    updateLabel();
    refresh();
    select.dispatchEvent(new Event("multichange", { bubbles: true }));
  }

  function refresh() {
    optionsEl.innerHTML = "";
    for (const opt of select.options) {
      if (multi) {
        const checked = state.isChecked(opt.value);
        const row = document.createElement("label");
        row.className = "select-option select-option-check" + (checked ? " selected" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        cb.addEventListener("change", () => toggleValue(opt.value));
        const span = document.createElement("span");
        span.className = "select-option-text";
        span.textContent = opt.textContent;
        span.title = opt.value;
        row.appendChild(cb);
        row.appendChild(span);
        optionsEl.appendChild(row);
      } else {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "select-option" + (opt.selected ? " selected" : "");
        item.textContent = opt.textContent;
        item.title = opt.value;
        if (opt.disabled) {
          item.classList.add("disabled");
          item.disabled = true;
        } else {
          item.addEventListener("click", () => {
            select.value = opt.value;
            updateLabel();
            close();
            select.dispatchEvent(new Event("change", { bubbles: true }));
          });
        }
        optionsEl.appendChild(item);
      }
    }
    if (multi) {
      const footer = document.createElement("div");
      footer.className = "select-footer";
      const allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "btn-link";
      allBtn.textContent = "Select All";
      allBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selectAll();
        updateLabel();
        refresh();
        select.dispatchEvent(new Event("multichange", { bubbles: true }));
      });
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "btn-link";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.clear();
        updateLabel();
        refresh();
        select.dispatchEvent(new Event("multichange", { bubbles: true }));
      });
      footer.appendChild(allBtn);
      footer.appendChild(clearBtn);
      // Bulk actions sit at the top so they're always reachable.
      optionsEl.insertBefore(footer, optionsEl.firstChild);
    }
    updateLabel();
  }

  function open() {
    document.querySelectorAll(".select-panel:not([hidden])").forEach((p) => {
      p.hidden = true;
    });
    document.querySelectorAll(".select-trigger.open").forEach((t) => t.classList.remove("open"));
    refresh();
    panel.hidden = false;
    trigger.classList.add("open");
  }

  function close() {
    panel.hidden = true;
    trigger.classList.remove("open");
  }

  trigger.addEventListener("click", () => {
    panel.hidden ? open() : close();
  });
  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (!e.target.closest("#" + triggerId) && !e.target.closest("#" + panelId)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  return { refresh, close, getSelected, setSelected, isMulti: multi };
}

// Shared calendar core used by both pickers so they render identically.
function renderCalendarGrid(weekdaysEl, daysEl, viewYear, viewMonth, decorate, onPick) {
  weekdaysEl.innerHTML = "";
  for (const w of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) {
    const span = document.createElement("span");
    span.textContent = w;
    weekdaysEl.appendChild(span);
  }
  daysEl.innerHTML = "";
  const startWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today = todayISO();
  for (let i = 0; i < startWeekday; i++) daysEl.appendChild(document.createElement("div"));
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "range-day";
    btn.textContent = day;
    btn.title = iso;
    btn.dataset.date = iso;
    if (iso === today) btn.classList.add("today");
    decorate(btn, iso);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(iso);
    });
    daysEl.appendChild(btn);
  }
}

function shiftViewMonth(view, delta) {
  view.viewMonth += delta;
  if (view.viewMonth < 0) {
    view.viewMonth = 11;
    view.viewYear--;
  }
  if (view.viewMonth > 11) {
    view.viewMonth = 0;
    view.viewYear++;
  }
}

// `getRecords()` -> array of canonical records; `localDateOf(rec)` -> local day.
// `onChange()` runs after a filter mutation (the dashboard re-renders).
// `getWorkspaceLabel(wsID)` supplies the display name for a workspace id.
export function createFilters({ getRecords, localDateOf, onChange, getWorkspaceLabel }) {
  const rangePicker = { start: "", end: "", viewYear: null, viewMonth: null };

  const wsCustom = initCustomSelect("workspaceSelect", "wsSelectTrigger", "wsSelectLabel", "wsSelectPanel", "wsSelectOptions", {
    multi: true,
    allLabel: "All Workspaces",
    labelFor: (v) => (getWorkspaceLabel ? getWorkspaceLabel(v) : v),
  });
  const modelCustom = initCustomSelect("modelSelect", "modelSelectTrigger", "modelSelectLabel", "modelSelectPanel", "modelSelectOptions", {
    multi: true,
    allLabel: "All Models",
  });

  function updateRangeTrigger() {
    document.getElementById("rangeLabel").textContent = rangeLabel(rangePicker);
  }

  function syncRangeInputs() {
    document.getElementById("startDate").value = rangePicker.start;
    document.getElementById("endDate").value = rangePicker.end;
    updateRangeTrigger();
  }

  function renderCalendar() {
    document.getElementById("rangeMonthLabel").textContent = new Date(
      rangePicker.viewYear,
      rangePicker.viewMonth,
      1
    ).toLocaleDateString("en-US", { month: "long", year: "numeric" });

    const start = rangePicker.start;
    const end = rangePicker.end || rangePicker.start;
    renderCalendarGrid(
      document.getElementById("rangeWeekdays"),
      document.getElementById("rangeDays"),
      rangePicker.viewYear,
      rangePicker.viewMonth,
      (btn, iso) => {
        if (iso === start) btn.classList.add("range-start");
        if (iso === end) btn.classList.add("range-end");
        if (start && end && iso >= start && iso <= end) btn.classList.add("in-range");
      },
      onRangeDayClick
    );
  }

  function onRangeDayClick(iso) {
    Object.assign(rangePicker, pickRangeDay(rangePicker, iso));
    syncRangeInputs();
    renderCalendar();
  }

  function applyRange() {
    syncRangeInputs();
    renderCalendar();
    onChange();
    closeRangePicker();
  }

  function openRangePicker() {
    const popup = document.getElementById("rangePopup");
    if (!popup.hidden) {
      closeRangePicker();
      return;
    }
    if (rangePicker.viewYear === null) {
      const ref = rangePicker.end || rangePicker.start || todayISO();
      rangePicker.viewYear = +ref.slice(0, 4);
      rangePicker.viewMonth = +ref.slice(5, 7) - 1;
    }
    renderCalendar();
    popup.hidden = false;
    document.getElementById("rangeTrigger").classList.add("open");
  }

  function closeRangePicker() {
    document.getElementById("rangePopup").hidden = true;
    document.getElementById("rangeTrigger").classList.remove("open");
  }

  function shiftRangeMonth(delta) {
    shiftViewMonth(rangePicker, delta);
    renderCalendar();
  }

  function applyPreset(name) {
    const { start, end } = presetRange(name);
    rangePicker.start = start;
    rangePicker.end = end;
    if (rangePicker.start) {
      rangePicker.viewYear = +rangePicker.start.slice(0, 4);
      rangePicker.viewMonth = +rangePicker.start.slice(5, 7) - 1;
    }
    syncRangeInputs();
    renderCalendar();
    onChange();
    closeRangePicker();
  }

  function clearRange() {
    rangePicker.start = "";
    rangePicker.end = "";
    syncRangeInputs();
    renderCalendar();
    onChange();
  }

  function initDateRange() {
    const { min, max } = dateBounds(getRecords(), localDateOf);
    if (min !== null) {
      const startDateInput = document.getElementById("startDate");
      const endDateInput = document.getElementById("endDate");
      if (!startDateInput.value) startDateInput.value = min;
      if (!endDateInput.value) endDateInput.value = max;
      rangePicker.start = startDateInput.value;
      rangePicker.end = endDateInput.value;
      updateRangeTrigger();
    }
  }

  function updateDropdowns() {
    const wsSelect = document.getElementById("workspaceSelect");
    const modelSelect = document.getElementById("modelSelect");
    const prevWS = wsCustom.getSelected();
    const prevModel = modelCustom.getSelected();

    const workspaces = new Set();
    const models = new Set();
    for (const rec of getRecords()) {
      const wsID = rec.workspaceID || "wrk_unknown";
      workspaces.add(`${rec.source || "opencode"}:${wsID}`);
      if (rec.model) models.add(rec.model);
    }

    wsSelect.innerHTML = "";
    for (const ws of Array.from(workspaces).sort()) {
      const option = document.createElement("option");
      option.value = ws;
      option.innerText = getWorkspaceLabel ? getWorkspaceLabel(ws) : ws;
      wsSelect.appendChild(option);
    }

    modelSelect.innerHTML = "";
    for (const m of Array.from(models).sort()) {
      const option = document.createElement("option");
      option.value = m;
      option.innerText = m;
      modelSelect.appendChild(option);
    }

    wsCustom.setSelected(prevWS);
    modelCustom.setSelected(prevModel);
    wsCustom.refresh();
    modelCustom.refresh();
  }

  // The dashboard recompute (aggregate + charts) is heavy, so defer it off the
  // click handler and coalesce rapid multi-select toggles. The checkbox state
  // already updates synchronously in toggleValue(), so the UI stays responsive
  // while the render happens a tick later.
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      onChange();
    }, 150);
  }

  function wire() {
    document.getElementById("workspaceSelect").addEventListener("multichange", scheduleRender);
    document.getElementById("modelSelect").addEventListener("multichange", scheduleRender);

    document.getElementById("rangeTrigger").addEventListener("click", openRangePicker);
    document.getElementById("rangePrev").addEventListener("click", () => shiftRangeMonth(-1));
    document.getElementById("rangeNext").addEventListener("click", () => shiftRangeMonth(1));
    document.getElementById("rangeClear").addEventListener("click", clearRange);
    document.getElementById("rangeApply").addEventListener("click", applyRange);
    document.querySelectorAll(".range-presets button").forEach((btn) => {
      btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
    });
    document.addEventListener("click", (e) => {
      if (document.getElementById("rangePopup").hidden) return;
      if (!e.target.closest(".date-range-group")) closeRangePicker();
    });
  }

  return {
    wire,
    updateDropdowns,
    initDateRange,
    renderCalendar,
    selectedWorkspace: () => wsCustom.getSelected(),
    selectedModel: () => modelCustom.getSelected(),
    startDate: () => document.getElementById("startDate").value,
    endDate: () => document.getElementById("endDate").value,
  };
}
