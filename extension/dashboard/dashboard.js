// dashboard.js - Same logic as the original opencode_dashboard.html, but the data is
// injected automatically by the extension. MV3 page CSP forbids inline scripts/handlers,
// so all events are wired here.

const globalCache = {};
let filteredRecordsCache = [];

let dailyChartInst = null;
let hourlyChartInst = null;
let modelChartInst = null;
let tokenTypeChartInst = null;
let hitRateChartInst = null;

// Day pinned by clicking a point on the daily chart (drill-down into the 24h chart).
// null = fall back to the last day of the selected range.
let selectedHourlyDate = null;

// Intraday chart view (Hybrid line / Heatmap).
let hourlyView = "hybrid"; // hybrid | heatmap
let lastHourlyMap = null;
let lastHourlyDate = null;
// Full-range hourly map (ignores the date range) used by the yearly calendar drill-down.
let lastFullHourlyMap = null;

// Table sort state. dir: 1 = ascending, -1 = descending.
const sortState = {
  ws: { col: "cost", dir: -1 },
  model: { col: "cost", dir: -1 },
};

// Chart palette - single desaturated brand blue (#6a8fc0) with opacity variants for series/slices.
const CHART_COLORS = {
  blue: "#6a8fc0",
  blueDim: "rgba(106, 143, 192, 0.35)",
  text: "#f2eded",
  muted: "#b8b2b2",
  surface: "#1c1c1f",
  border: "#38383a",
  grid: "rgba(255, 255, 255, 0.07)",
};
const CHART_FONT = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// Single-hue opacity ramp so multi-slice charts stay monochromatic.
function monoTones(n) {
  return Array.from({ length: n }, (_, i) => `rgba(106, 143, 192, ${(1 - i / n).toFixed(3)})`);
}

// Recursive merge so per-chart overrides layer on top of the shared theme.
function mergeDeep(...objects) {
  const out = {};
  for (const obj of objects) {
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
        out[k] = mergeDeep(out[k], v);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function compactTick(n) {
  const abs = Math.abs(n);
  let v, sfx = "";
  if (abs >= 1e9) { v = n / 1e9; sfx = "b"; }
  else if (abs >= 1e6) { v = n / 1e6; sfx = "m"; }
  else if (abs >= 1e3) { v = n / 1e3; sfx = "k"; }
  else return String(Math.round(n));
  return `${Number(v.toFixed(1)).toString()}${sfx}`;
}

// Shared axis styling: muted ticks + subtle grid, mono font.
function axis(extra = {}) {
  return mergeDeep(
    {
      grid: { color: CHART_COLORS.grid },
      ticks: { color: CHART_COLORS.muted, font: { family: CHART_FONT, size: 11 } },
    },
    extra
  );
}

// Shared chart options: dark tooltip, brand legend, mono fonts everywhere.
function chartOptions(overrides = {}) {
  return mergeDeep(
    {
      responsive: true,
      plugins: {
        legend: { labels: { color: CHART_COLORS.text, font: { family: CHART_FONT, size: 12 } } },
        tooltip: {
          backgroundColor: CHART_COLORS.surface,
          titleColor: CHART_COLORS.text,
          bodyColor: CHART_COLORS.text,
          borderColor: CHART_COLORS.border,
          borderWidth: 1,
          padding: 10,
          cornerRadius: 6,
          titleFont: { family: CHART_FONT },
          bodyFont: { family: CHART_FONT },
        },
      },
    },
    overrides
  );
}

function sortBy(arr, col, dir) {
  return arr.slice().sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    if (va === vb) return 0;
    return va > vb ? dir : -dir;
  });
}

// Format USD with thousands separators, keeping a fixed number of decimals.
const fmtMoney = (v, digits = 4) =>
  (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Escape strings that come from external data (model names, workspace IDs) before
// they are injected via innerHTML into table cells.
const escHTML = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

// Local date (YYYY-MM-DD) of a record, computed from its UTC `time` at display
// time so it always reflects the viewer's timezone. Falls back to the stored
// `date` for legacy records without a timestamp.
function localDateOf(rec) {
  if (rec.time) {
    const t = new Date(rec.time);
    if (!isNaN(t.getTime())) {
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    }
  }
  return rec.date || "Unknown";
}

function markSortHeader(tableId, col, dir) {
  document.querySelectorAll(`#${tableId} th[data-col]`).forEach((th) => {
    if (th.dataset.base === undefined) th.dataset.base = th.textContent;
    const isSorted = th.dataset.col === col;
    th.textContent = isSorted ? th.dataset.base + (dir === -1 ? " ▼" : " ▲") : th.dataset.base;
    th.classList.toggle("th-sorted", isSorted);
  });
}

function initDateRange() {
  const dates = [];
  for (const rec of Object.values(globalCache)) {
    const d = localDateOf(rec);
    if (d && d !== "Unknown") dates.push(d);
  }
  if (dates.length > 0) {
    dates.sort();
    const startDateInput = document.getElementById("startDate");
    const endDateInput = document.getElementById("endDate");
    if (!startDateInput.value) startDateInput.value = dates[0];
    if (!endDateInput.value) endDateInput.value = dates[dates.length - 1];
    rangePicker.start = startDateInput.value;
    rangePicker.end = endDateInput.value;
    updateRangeTrigger();
  }
}

// ===== Custom date range picker =====
const rangePicker = {
  start: "",
  end: "",
  viewYear: null, // displayed calendar month (year)
  viewMonth: null, // displayed calendar month (0-based)
};

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayISO() {
  return toISODate(new Date());
}

// Shared calendar core used by BOTH the date-range picker and the single
// date+time picker, so the two always render identically.
// decorate(btn, iso) applies per-picker highlight classes; onPick(iso) handles selection.
function renderCalendarGrid(weekdaysEl, daysEl, viewYear, viewMonth, decorate, onPick) {
  weekdaysEl.innerHTML = "";
  for (const w of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) {
    const span = document.createElement("span");
    span.textContent = w;
    weekdaysEl.appendChild(span);
  }
  daysEl.innerHTML = "";
  const startWeekday = new Date(viewYear, viewMonth, 1).getDay(); // 0 = Sunday
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
      // Stop propagation so re-rendering (which detaches this button) can't
      // make the document-level click handler misread it as an outside click.
      e.stopPropagation();
      onPick(iso);
    });
    daysEl.appendChild(btn);
  }
}

// Shared month navigation for both pickers.
function shiftViewMonth(view, delta) {
  view.viewMonth += delta;
  if (view.viewMonth < 0) { view.viewMonth = 11; view.viewYear--; }
  if (view.viewMonth > 11) { view.viewMonth = 0; view.viewYear++; }
}

function fmtISO(dateStr) {
  return dateStr ? dateStr : "—";
}

function updateRangeTrigger() {
  const label = document.getElementById("rangeLabel");
  if (rangePicker.start && rangePicker.end) {
    label.textContent = `${fmtISO(rangePicker.start)} → ${fmtISO(rangePicker.end)}`;
  } else if (rangePicker.start || rangePicker.end) {
    label.textContent = rangePicker.start ? fmtISO(rangePicker.start) : `Until ${fmtISO(rangePicker.end)}`;
  } else {
    label.textContent = "All Time";
  }
}

function syncRangeInputs() {
  document.getElementById("startDate").value = rangePicker.start;
  document.getElementById("endDate").value = rangePicker.end;
  updateRangeTrigger();
}

function renderCalendar() {
  document.getElementById("rangeMonthLabel").textContent =
    new Date(rangePicker.viewYear, rangePicker.viewMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // A start-only selection means a single day, so highlight it as start = end.
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
  if (!rangePicker.start || (rangePicker.start && rangePicker.end)) {
    // Begin a fresh selection.
    rangePicker.start = iso;
    rangePicker.end = "";
  } else {
    // Complete the range (swap if picked backwards).
    let s = rangePicker.start, e = iso;
    if (e < s) { const t = s; s = e; e = t; }
    rangePicker.start = s;
    rangePicker.end = e;
  }
  syncRangeInputs();
  renderCalendar();
}

function applyRange() {
  syncRangeInputs();
  renderCalendar();
  renderDashboard();
  closeRangePicker();
}

function openRangePicker() {
  const popup = document.getElementById("rangePopup");
  if (!popup.hidden) { closeRangePicker(); return; }
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
  const now = new Date();
  switch (name) {
    case "today": rangePicker.start = todayISO(); rangePicker.end = todayISO(); break;
    case "all": rangePicker.start = ""; rangePicker.end = ""; break;
    case "7d": {
      const s = new Date(); s.setDate(s.getDate() - 6);
      rangePicker.start = toISODate(s); rangePicker.end = toISODate(now);
      break;
    }
    case "30d": {
      const s = new Date(); s.setDate(s.getDate() - 29);
      rangePicker.start = toISODate(s); rangePicker.end = toISODate(now);
      break;
    }
    case "month":
      rangePicker.start = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
      rangePicker.end = toISODate(now);
      break;
  }
  if (rangePicker.start) {
    rangePicker.viewYear = +rangePicker.start.slice(0, 4);
    rangePicker.viewMonth = +rangePicker.start.slice(5, 7) - 1;
  }
  syncRangeInputs();
  renderCalendar();
  renderDashboard();
  closeRangePicker();
}

function clearRange() {
  rangePicker.start = "";
  rangePicker.end = "";
  syncRangeInputs();
  renderCalendar();
  renderDashboard();
}

// ===== Custom dropdowns =====
// Mirrors a hidden native <select> (source of truth for value/change) into a styled popup.
function initCustomSelect(selectId, triggerId, labelId, panelId, optionsId) {
  const select = document.getElementById(selectId);
  const trigger = document.getElementById(triggerId);
  const label = document.getElementById(labelId);
  const panel = document.getElementById(panelId);
  const optionsEl = document.getElementById(optionsId);

  function refresh() {
    optionsEl.innerHTML = "";
    for (const opt of select.options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "select-option" + (opt.selected ? " selected" : "");
      item.textContent = opt.textContent;
      item.title = opt.value;
      item.addEventListener("click", (e) => {
        select.value = opt.value;
        label.textContent = opt.textContent;
        close();
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      optionsEl.appendChild(item);
    }
    const selected = select.selectedOptions[0];
    if (selected) label.textContent = selected.textContent;
  }

  function open() {
    // Only one dropdown open at a time.
    document.querySelectorAll(".select-panel:not([hidden])").forEach((p) => { p.hidden = true; });
    document.querySelectorAll(".select-trigger.open").forEach((t) => t.classList.remove("open"));
    refresh();
    panel.hidden = false;
    trigger.classList.add("open");
  }

  function close() {
    panel.hidden = true;
    trigger.classList.remove("open");
  }

  trigger.addEventListener("click", (e) => {
    panel.hidden ? open() : close();
  });
  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (!e.target.closest("#" + triggerId) && !e.target.closest("#" + panelId)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  return { refresh, close };
}

const wsCustom = initCustomSelect("workspaceSelect", "wsSelectTrigger", "wsSelectLabel", "wsSelectPanel", "wsSelectOptions");
const modelCustom = initCustomSelect("modelSelect", "modelSelectTrigger", "modelSelectLabel", "modelSelectPanel", "modelSelectOptions");

function updateDropdowns() {
  const wsSelect = document.getElementById("workspaceSelect");
  const modelSelect = document.getElementById("modelSelect");

  const currentWS = wsSelect.value;
  const currentModel = modelSelect.value;

  const workspaces = new Set();
  const models = new Set();

  for (const rec of Object.values(globalCache)) {
    workspaces.add(rec.workspaceID || "wrk_unknown");
    if (rec.model) models.add(rec.model);
  }

  wsSelect.innerHTML = '<option value="ALL">All Workspaces (Total)</option>';
  for (const ws of Array.from(workspaces).sort()) {
    const option = document.createElement("option");
    option.value = ws;
    option.innerText = `Workspace: ${ws}`;
    wsSelect.appendChild(option);
  }
  wsSelect.value = currentWS;

  modelSelect.innerHTML = '<option value="ALL">All Models</option>';
  for (const m of Array.from(models).sort()) {
    const option = document.createElement("option");
    option.value = m;
    option.innerText = m;
    modelSelect.appendChild(option);
  }
  modelSelect.value = currentModel;

  wsCustom.refresh();
  modelCustom.refresh();
}

// ===== v2 Rate Settings =====
// Each rule matches by exact model name (rule.model === record.model).
// rates array: each version has an "effective from" time (from, null = earliest) + billing mode.
// Versions are ordered by from: each version is valid until the next version's from; the last version is permanent.
//   Flat: pricing.flat (no time windows)
//   Time-based: windows.peak (peak windows, off-peak is the complement) + pricing.peak + pricing.offpeak
// Price tables may be tiered (low/high by input+cacheRead total context).
// Rates are USD per million tokens.
const RATES_VERSION = 5;
const RATES_KEY = "opencode_model_rates_v2";

const DEFAULT_MODEL_RATES = [
  // Free models - big-pickle stays free; hy3/mimo have paid + free variants;
  // the rest are free-only (data uses the -free suffix)
  { id: "r1", model: "big-pickle", rates: [{ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
  { id: "r2", model: "hy3", rates: [{ from: null, pricing: { flat: { input: 0.13, output: 0.53, cacheRead: 0.043, cacheWrite: 0.13 } } }] },
  // Hy3 Free - same model from a different source, rates duplicated
  { id: "r2b", model: "hy3-free", rates: [{ from: null, pricing: { flat: { input: 0.13, output: 0.53, cacheRead: 0.043, cacheWrite: 0.13 } } }] },
  { id: "r3", model: "laguna-s-2.1-free", rates: [{ from: null, pricing: { flat: { input: 0.09, output: 0.18, cacheRead: 0.045, cacheWrite: 0.09 } } }] },
  { id: "r4", model: "ling-3.0-flash-free", rates: [{ from: null, pricing: { flat: { input: 0.021, output: 0.063, cacheRead: 0.0042, cacheWrite: 0.021 } } }] },
  { id: "r5", model: "nemotron-3-ultra-free", rates: [{ from: null, pricing: { flat: { input: 0.5, output: 2.2, cacheRead: 0.1, cacheWrite: 0.5 } } }] },
  { id: "r6", model: "nemotron-3.5-lightning-free", rates: [{ from: null, pricing: { flat: { input: 0.1, output: 0.25, cacheRead: 0.05, cacheWrite: 0.1 } } }] },

  // DeepSeek V4 Flash - switched to peak/off-peak billing from 2026-08-16T16:00:00Z
  {
    id: "r7",
    model: "deepseek-v4-flash",
    rates: [
      { from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        windows: {
          peak: [
            { days: [0,1,2,3,4,5,6], start: "01:00", end: "04:00" },
            { days: [0,1,2,3,4,5,6], start: "06:00", end: "10:00" },
          ],
        },
        pricing: {
          peak: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
          offpeak: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
        },
      },
    ],
  },
  // DeepSeek V4 Flash Free - same model from a different source, rates duplicated
  {
    id: "r7b",
    model: "deepseek-v4-flash-free",
    rates: [
      { from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        windows: {
          peak: [
            { days: [0,1,2,3,4,5,6], start: "01:00", end: "04:00" },
            { days: [0,1,2,3,4,5,6], start: "06:00", end: "10:00" },
          ],
        },
        pricing: {
          peak: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
          offpeak: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
        },
      },
    ],
  },

  // DeepSeek V4 Pro - switched to peak/off-peak billing from 2026-08-16T16:00:00Z
  {
    id: "r18",
    model: "deepseek-v4-pro",
    rates: [
      { from: null, pricing: { flat: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        windows: {
          peak: [
            { days: [0,1,2,3,4,5,6], start: "01:00", end: "04:00" },
            { days: [0,1,2,3,4,5,6], start: "06:00", end: "10:00" },
          ],
        },
        pricing: {
          peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
          offpeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
        },
      },
    ],
  },
  // DeepSeek V4 Pro Free - same model from a different source, rates duplicated
  {
    id: "r18b",
    model: "deepseek-v4-pro-free",
    rates: [
      { from: null, pricing: { flat: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        windows: {
          peak: [
            { days: [0,1,2,3,4,5,6], start: "01:00", end: "04:00" },
            { days: [0,1,2,3,4,5,6], start: "06:00", end: "10:00" },
          ],
        },
        pricing: {
          peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
          offpeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
        },
      },
    ],
  },

  // Other models - single flat version, no time windows
  { id: "r8", model: "glm-5.3", rates: [{ from: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }] },
  { id: "r8b", model: "glm-5.2", rates: [{ from: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }] },
  { id: "r12", model: "glm-5.1", rates: [{ from: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }] },
  { id: "r9", model: "kimi-k2.7-code", rates: [{ from: null, pricing: { flat: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 } } }] },
  { id: "r10", model: "kimi-k2.6", rates: [{ from: null, pricing: { flat: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 } } }] },
  { id: "r13", model: "kimi-k3", rates: [{ from: null, pricing: { flat: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 } } }] },
  { id: "r11", model: "grok-4.5", rates: [{ from: null, pricing: { flat: { input: 2.0, output: 6.0, cacheRead: 0.3, cacheWrite: 0 } } }] },
  { id: "r14", model: "mimo-v2.5-pro", rates: [{ from: null, pricing: { flat: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } } }] },
  { id: "r15", model: "mimo-v2.5", rates: [{ from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } }] },
  // MiMo V2.5 Free - same model from a different source, rates duplicated
  { id: "r15b", model: "mimo-v2.5-free", rates: [{ from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } }] },
  { id: "r16", model: "minimax-m3", rates: [{ from: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 } } }] },
  { id: "r17", model: "minimax-m2.7", rates: [{ from: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 } } }] },
  { id: "r17b", model: "minimax-m2.5", rates: [{ from: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 } } }] },
  { id: "r19", model: "qwen3.8-max", rates: [{ from: null, pricing: { flat: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 } } }] },
  { id: "r20", model: "qwen-3.7-max", rates: [{ from: null, pricing: { flat: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 } } }] },
  {
    id: "r21",
    model: "qwen-3.7-plus",
    rates: [{ from: null, pricing: { flat: { tier: { limit: 256000, low: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 }, high: { input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 1.5 } } } } }],
  },
  {
    id: "r22",
    model: "qwen-3.6-plus",
    rates: [{ from: null, pricing: { flat: { tier: { limit: 256000, low: { input: 0.5, output: 3.0, cacheRead: 0.05, cacheWrite: 0.625 }, high: { input: 2.0, output: 6.0, cacheRead: 0.2, cacheWrite: 2.5 } } } } }],
  },
  { id: "r23", model: "gpt-5.6-luna",
    rates: [{ from: null, pricing: { flat: { tier: { limit: 272000, low: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }, high: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 } } } } }],
  },
  { id: "r24", model: "muse-spark-1.2-contributor", rates: [{ from: null, pricing: { flat: { input: 0.10, output: 0.20, cacheRead: 0.002, cacheWrite: 0 } } }] },
  { id: "r25", model: "ox-alpha-free", rates: [{ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
];

// Version upgrade = overwrite: stored version != current version → use new built-in defaults.
// User edits within the same version are preserved (saved back to the same key).
function getRates() {
  try {
    const raw = localStorage.getItem(RATES_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && cfg.version === RATES_VERSION && Array.isArray(cfg.models) && cfg.models.length > 0) {
        return cfg.models;
      }
    }
  } catch (e) {}
  return DEFAULT_MODEL_RATES;
}

function saveRates(models) {
  localStorage.setItem(RATES_KEY, JSON.stringify({ version: RATES_VERSION, timezone: "UTC", models }));
  // Mirror the config into chrome.storage so the popup's time reminder can read
  // the peak windows (popup can't access this page's localStorage).
  try {
    chrome.storage.local.set({ [TIME_RATES_KEY]: models });
  } catch (e) {}
}

// ===== Model matching & calculation logic =====
// Exact match: rule.model === record.model, no keywords, no collisions.
function matchRule(modelName, rules) {
  for (const rule of rules) {
    if (rule.model === modelName) return rule;
  }
  return null;
}

// Parse effective-from bounds to timestamps; null/empty string → null (earliest).
function parseBound(bound) {
  if (bound == null || bound === "") return null;
  const t = new Date(bound).getTime();
  return isNaN(t) ? null : t;
}

// Pick the rate version by record time: versions are sorted by "effective from",
// and the last version whose from <= record time wins. Latest version when time can't be parsed.
function getRateEntry(rule, recordTime) {
  const ts = new Date(recordTime).getTime();
  const validTs = isNaN(ts) ? null : ts;
  const versions = (rule.rates || []).slice().sort((a, b) => {
    const aFrom = parseBound(a.from);
    const bFrom = parseBound(b.from);
    if (aFrom === null && bFrom === null) return 0;
    if (aFrom === null) return -1; // null = earliest
    if (bFrom === null) return 1;
    return aFrom - bFrom;
  });
  if (versions.length === 0) return null;
  // No parseable time → use the earliest/base version (flat) instead of the
  // latest, so records without a timestamp are never charged peak rates.
  if (validTs === null) return versions[0];
  let selected = versions[0];
  for (const v of versions) {
    const fromTs = parseBound(v.from);
    if (fromTs !== null && validTs < fromTs) break;
    selected = v;
  }
  return selected;
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Determine window: no windows → flat; inside any peak window → peak; otherwise offpeak (complement).
function getWindow(record, entry) {
  const peakWindows = entry.windows && entry.windows.peak;
  if (!peakWindows || peakWindows.length === 0) return "flat";
  const t = new Date(record.time);
  if (isNaN(t.getTime())) return "flat";
  const weekday = t.getUTCDay(); // Always UTC
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  for (const w of peakWindows) {
    const days = w.days || [];
    if (days.length > 0 && !days.includes(weekday)) continue;
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start == null || end == null) continue;
    if (start <= end) {
      if (minutes >= start && minutes < end) return "peak";
    } else {
      // Crosses midnight: after start or before end
      if (minutes >= start || minutes < end) return "peak";
    }
  }
  return "offpeak";
}

// Resolve price table by window; fall back to the other window's table when missing (conservative); tier by input+cacheRead total context.
function resolveTable(entry, window, inputTokens, cacheReadTokens) {
  const pricing = entry.pricing || {};
  let table = pricing[window];
  // Fall back to the other window only for peak/offpeak. A "flat" window with
  // no flat table means the config is incomplete - never fall back to peak.
  if (!table && window !== "flat") table = window === "peak" ? pricing.offpeak : pricing.peak;
  if (!table) return null;
  if (table.tier) {
    const context = (inputTokens || 0) + (cacheReadTokens || 0);
    const tierTable = context <= table.tier.limit ? table.tier.low : table.tier.high;
    if (tierTable) return tierTable;
    // Incomplete tier → fall back to table-level rates
    if (table.input !== undefined || table.output !== undefined) return table;
    return null;
  }
  return table;
}

// Compute cost and savings for a single record. Returns window for split display; unpriced marks unpriced records.
function getRecordCostAndSavings(record, rates = getRates()) {
  const rule = matchRule(record.model || "", rates);
  if (!rule) return { cost: 0, savings: 0, window: null, unpriced: true };
  const entry = getRateEntry(rule, record.time);
  if (!entry) return { cost: 0, savings: 0, window: null, unpriced: true };
  const window = getWindow(record, entry);
  const table = resolveTable(entry, window, record.input, record.cacheRead);
  if (!table) return { cost: 0, savings: 0, window, unpriced: true };
  const inputRate = table.input || 0;
  const outputRate = table.output || 0;
  const cacheReadRate = table.cacheRead || 0;
  const cacheWriteRate = table.cacheWrite || 0;
  const cacheWriteTokens = (record.cacheWrite5m || 0) + (record.cacheWrite1h || 0);
  const cost = ((record.input || 0) * inputRate + (record.cacheRead || 0) * cacheReadRate + cacheWriteTokens * cacheWriteRate + (record.output || 0) * outputRate) / 1000000;
  const savings = (record.cacheRead || 0) * (inputRate - cacheReadRate) / 1000000;
  return { cost, savings, window, unpriced: false };
}

// Intraday drill-down chart: one day's cost/token curve. Clicking a point on
// the daily chart pins that day; otherwise it defaults to the last day of the
// selected range (falling back to the latest day that has data).
// Two interchangeable views: Hybrid (line, styled like the daily chart) / Heatmap.
function renderHourlyChart(hourlyMap, fallbackDate) {
  let hourlyDate = null;
  if (selectedHourlyDate && hourlyMap[selectedHourlyDate]) {
    hourlyDate = selectedHourlyDate;
  } else {
    const availableDates = Object.keys(hourlyMap).sort();
    if (availableDates.length > 0) {
      hourlyDate = fallbackDate && hourlyMap[fallbackDate] ? fallbackDate : availableDates[availableDates.length - 1];
    }
  }

  lastHourlyMap = hourlyMap;
  lastHourlyDate = hourlyDate;

  const dateEl = document.getElementById("hourlyChartDate");
  if (dateEl) dateEl.textContent = hourlyDate || "—";

  // Clear any previous chart / heatmap grid.
  if (hourlyChartInst) hourlyChartInst.destroy();
  hourlyChartInst = null;
  const wrap = document.getElementById("hourlyChartWrap");
  const canvas = document.getElementById("hourlyChart");
  const oldGrid = wrap && wrap.querySelector(".heatmap");
  if (oldGrid) oldGrid.remove();
  if (canvas) canvas.style.display = "";
  if (!hourlyDate) return;

  if (hourlyView === "heatmap") renderHourlyHeatmap(hourlyMap, hourlyDate);
  else renderHourlyHybrid(hourlyMap, hourlyDate);
}

// Heatmap view: 24h × 60min grid, colored by cost intensity (darker = higher).
// Hovering a cell shows a tooltip with the exact time, cost and tokens.
function renderHourlyHeatmap(hourlyMap, date) {
  const wrap = document.getElementById("hourlyChartWrap");
  const canvas = document.getElementById("hourlyChart");
  canvas.style.display = "none";
  const dayData = hourlyMap[date] || {};
  let maxCost = 0;
  for (const k in dayData) if (dayData[k].cost > maxCost) maxCost = dayData[k].cost;

  const grid = document.createElement("div");
  grid.className = "heatmap";
  grid.style.cssText =
    "display:grid; grid-template-columns: 30px repeat(60, 1fr); gap:1px; " +
    "font-family:var(--font-mono); font-size:9px; color:var(--text-muted); align-items:center;";

  const label = (text, align) => {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = `text-align:${align}; padding:0 4px;`;
    return d;
  };

  // Custom hover tooltip (native title is slow and unstyled).
  const tip = document.createElement("div");
  tip.style.cssText =
    "position:fixed; pointer-events:none; z-index:60; display:none; " +
    "background:var(--surface); border:1px solid var(--border); border-radius:6px; " +
    "padding:8px 10px; font-family:var(--font-mono); font-size:11px; color:var(--text); " +
    "box-shadow:0 4px 16px rgba(0,0,0,.4);";
  wrap.appendChild(tip);

  grid.appendChild(label("", "right")); // corner
  for (let m = 0; m < 60; m++) grid.appendChild(label(m % 15 === 0 ? String(m).padStart(2, "0") : "", "center"));
  for (let h = 0; h < 24; h++) {
    grid.appendChild(label(String(h).padStart(2, "0"), "right"));
    for (let m = 0; m < 60; m++) {
      const idx = h * 60 + m;
      const d = dayData[idx];
      const cell = document.createElement("div");
      const opacity = d ? Math.max(0.1, Math.sqrt(d.cost / maxCost)) : 0.03;
      cell.style.cssText = `background: rgba(106,143,192,${opacity}); border-radius:1px; aspect-ratio:1;`;
      if (d) {
        const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        cell.addEventListener("mouseenter", () => {
          tip.innerHTML =
            `<div style="color:var(--text-muted); margin-bottom:4px;">${time}</div>` +
            `Cost: <strong>$${d.cost.toFixed(4)}</strong><br>` +
            `Tokens: <strong>${d.tokens.toLocaleString()}</strong>`;
          tip.style.display = "block";
        });
        cell.addEventListener("mousemove", (e) => {
          tip.style.left = (e.clientX + 14) + "px";
          tip.style.top = (e.clientY + 14) + "px";
        });
        cell.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      }
      grid.appendChild(cell);
    }
  }
  wrap.appendChild(grid);
}

// Hybrid view: 24 hourly points, styled exactly like the Daily Cost chart
// (solid filled cost line + dashed token line, dual axes, x-axis hover).
function renderHourlyHybrid(hourlyMap, date) {
  const dayData = hourlyMap[date] || {};
  const labels = [], costs = [], tokens = [];
  for (let h = 0; h < 24; h++) {
    let c = 0, t = 0;
    for (let m = h * 60; m < h * 60 + 60; m++) {
      if (dayData[m]) { c += dayData[m].cost; t += dayData[m].tokens; }
    }
    labels.push(`${String(h).padStart(2, "0")}:00`);
    costs.push(c);
    tokens.push(t);
  }
  hourlyChartInst = new Chart(document.getElementById("hourlyChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Cost (USD)", data: costs, borderColor: CHART_COLORS.blue, backgroundColor: "rgba(106, 143, 192, 0.15)", yAxisID: "yCost", fill: true, tension: 0.3 },
        { label: "Token Volume", data: tokens, borderColor: CHART_COLORS.blueDim, yAxisID: "yToken", borderDash: [5, 5], tension: 0.3 }
      ]
    },
    options: chartOptions({
      interaction: { mode: "index", intersect: false },
      scales: {
        x: axis({
          ticks: {
            maxRotation: 0,
            minRotation: 0,
            autoSkip: true,
          }
        }),
        yCost: axis({ type: "linear", position: "left" }),
        yToken: axis({ type: "linear", position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v) => compactTick(v) } })
      }
    })
  });
}

// Daily Line view: cost + token trend, click a day to drill into the 24h chart.
function renderDailyLine(dailyMap, dailyTokenMap, hourlyMap, endDate) {
  if (dailyChartInst) dailyChartInst.destroy();
  dailyChartInst = null;
  const dates = Object.keys(dailyMap).sort();
  const dailyCosts = dates.map((d) => dailyMap[d]);
  const dailyTokens = dates.map((d) => dailyTokenMap[d]);
  dailyChartInst = new Chart(document.getElementById("dailyChart"), {
    type: "line",
    data: {
      labels: dates,
      datasets: [
        { label: "Daily Cost (USD)", data: dailyCosts, borderColor: CHART_COLORS.blue, backgroundColor: "rgba(106, 143, 192, 0.15)", yAxisID: "yCost", fill: true, tension: 0.3 },
        { label: "Token Volume", data: dailyTokens, borderColor: CHART_COLORS.blueDim, yAxisID: "yToken", borderDash: [5, 5], tension: 0.3 }
      ]
    },
    options: chartOptions({
      // Hover/click anywhere along the x-axis selects that day (no need to hit the point).
      interaction: { mode: "index", intersect: false },
      onClick: (evt, elements, chart) => {
        if (elements && elements.length > 0) {
          const date = chart.data.labels[elements[0].index];
          if (date) {
            selectedHourlyDate = date;
            renderHourlyChart(hourlyMap, endDate);
          }
        }
      },
      scales: {
        x: axis({
          ticks: {
            // Keep labels horizontal (no auto-rotation) and skip some when dense.
            maxRotation: 0,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            // Short axis labels ("JUL 11"); the tooltip still shows the full date.
            callback: (value, index) => {
              const d = dates[index];
              if (!d) return "";
              return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
            }
          }
        }),
        yCost: axis({ type: "linear", position: "left" }),
        yToken: axis({ type: "linear", position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v) => compactTick(v) } })
      }
    })
  });
}

// GitHub-style yearly activity calendar: one cell per day for the last 365 days,
// colored by cost intensity. Respects workspace/model filters (ignores the date
// range). Hover shows cost/tokens; clicking a day drills into the 24h chart.
function renderYearlyHeatmap() {
  const wrap = document.getElementById("yearlyHeatmapWrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  const selectedWS = document.getElementById("workspaceSelect").value;
  const selectedModel = document.getElementById("modelSelect").value;
  const rates = getRates();

  // Aggregate cost/tokens per date (and per minute for drill-down), ignoring the date range.
  const daily = {};
  const hourly = {};
  for (const rec of Object.values(globalCache)) {
    const wsID = rec.workspaceID || "wrk_unknown";
    const modelName = rec.model || "Unknown";
    if (selectedWS !== "ALL" && wsID !== selectedWS) continue;
    if (selectedModel !== "ALL" && modelName !== selectedModel) continue;
    const date = localDateOf(rec);
    if (date === "Unknown") continue;
    const { cost } = getRecordCostAndSavings(rec, rates);
    const tokens = (rec.input || 0) + (rec.output || 0) + (rec.reasoning || 0) + (rec.cacheRead || 0) + (rec.cacheWrite5m || 0) + (rec.cacheWrite1h || 0);
    if (!daily[date]) daily[date] = { cost: 0, tokens: 0 };
    daily[date].cost += cost;
    daily[date].tokens += tokens;
    if (rec.time) {
      const t = new Date(rec.time);
      if (!isNaN(t.getTime())) {
        const min = t.getHours() * 60 + t.getMinutes();
        if (!hourly[date]) hourly[date] = {};
        const h = hourly[date][min] || (hourly[date][min] = { cost: 0, tokens: 0 });
        h.cost += cost;
        h.tokens += tokens;
      }
    }
  }
  lastFullHourlyMap = hourly;

  const dates = Object.keys(daily).sort();
  if (dates.length === 0) {
    wrap.innerHTML = '<div class="notice">No data for the current filters.</div>';
    return;
  }

  // Window: last 365 days ending at the latest date with data.
  const lastDate = new Date(dates[dates.length - 1] + "T00:00:00");
  const firstDate = new Date(lastDate);
  firstDate.setDate(firstDate.getDate() - 364);

  // Grid: weeks as columns, Mon-Sun rows (GitHub style).
  const start = new Date(firstDate);
  start.setDate(firstDate.getDate() - ((firstDate.getDay() + 6) % 7)); // Monday of first week
  const end = new Date(lastDate);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7))); // Sunday of last week

  const weeks = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    weeks.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }

  // Group consecutive weeks by month for the top labels.
  const monthGroups = [];
  for (const w of weeks) {
    const key = w.getFullYear() + "-" + w.getMonth();
    const lastGroup = monthGroups[monthGroups.length - 1];
    if (!lastGroup || lastGroup.key !== key) {
      monthGroups.push({ key, year: w.getFullYear(), month: w.getMonth(), count: 1 });
    } else {
      lastGroup.count++;
    }
  }

  let maxCost = 0;
  for (const d of dates) if (daily[d].cost > maxCost) maxCost = daily[d].cost;

  const GAP = 2;
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const label = (text, align) => {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = `text-align:${align}; padding:0 4px;`;
    return d;
  };

  const grid = document.createElement("div");
  grid.style.cssText =
    "display:grid; width:100%; gap:" + GAP + "px; " +
    `grid-template-columns: repeat(${weeks.length}, 1fr); ` +
    "grid-template-rows: 18px repeat(7, auto); " +
    "font-family:var(--font-mono); font-size:9px; color:var(--text-muted);";

  // Custom hover tooltip.
  const tip = document.createElement("div");
  tip.style.cssText =
    "position:fixed; pointer-events:none; z-index:60; display:none; " +
    "background:var(--surface); border:1px solid var(--border); border-radius:6px; " +
    "padding:8px 10px; font-family:var(--font-mono); font-size:11px; color:var(--text); " +
    "box-shadow:0 4px 16px rgba(0,0,0,.4);";
  wrap.appendChild(tip);

  // Month labels (row 1).
  for (const g of monthGroups) {
    const name = new Date(g.year, g.month, 1).toLocaleDateString("en-US", { month: "short" });
    const el = label(name, "left");
    el.style.gridColumn = `span ${g.count}`;
    grid.appendChild(el);
  }

  // Day rows (Mon-Sun), no labels.
  for (let di = 0; di < 7; di++) {
    for (let wi = 0; wi < weeks.length; wi++) {
      const d = new Date(weeks[wi]);
      d.setDate(d.getDate() + di);
      const key = iso(d);
      const has = Object.prototype.hasOwnProperty.call(daily, key);
      const cell = document.createElement("div");
      const opacity = has ? Math.max(0.08, Math.sqrt(daily[key].cost / maxCost)) : 0.03;
      cell.style.cssText = `width:100%; aspect-ratio:1; background: rgba(106,143,192,${opacity}); border:1px solid rgba(255,255,255,0.05); border-radius:2px;`;
      if (has) {
        const cost = daily[key].cost;
        const tokens = daily[key].tokens;
        cell.style.cursor = "pointer";
        cell.addEventListener("mouseenter", () => {
          tip.innerHTML =
            `<div style="color:var(--text-muted); margin-bottom:4px;">${key}</div>` +
            `Cost: <strong>$${cost.toFixed(4)}</strong><br>` +
            `Tokens: <strong>${tokens.toLocaleString()}</strong>`;
          tip.style.display = "block";
        });
        cell.addEventListener("mousemove", (e) => {
          tip.style.left = (e.clientX + 14) + "px";
          tip.style.top = (e.clientY + 14) + "px";
        });
        cell.addEventListener("mouseleave", () => { tip.style.display = "none"; });
        cell.addEventListener("click", () => {
          selectedHourlyDate = key;
          renderHourlyChart(lastFullHourlyMap, key);
        });
      }
      grid.appendChild(cell);
    }
  }

  wrap.appendChild(grid);

  // Legend (Less → More).
  const legend = document.createElement("div");
  legend.style.cssText = "display:flex; justify-content:center; align-items:center; gap:4px; margin-top:10px; font-family:var(--font-mono); font-size:10px; color:var(--text-muted);";
  legend.appendChild(document.createTextNode("Less"));
  for (let i = 0; i < 5; i++) {
    const s = document.createElement("div");
    const o = i === 0 ? 0.03 : 0.15 + i * 0.2;
    s.style.cssText = `width:12px; height:12px; background:rgba(106,143,192,${o}); border-radius:2px; border:1px solid rgba(255,255,255,0.05);`;
    legend.appendChild(s);
  }
  legend.appendChild(document.createTextNode("More"));
  wrap.appendChild(legend);

  const badge = document.getElementById("yearlyRange");
  if (badge) badge.textContent = `${iso(firstDate)} → ${iso(lastDate)}`;
}

function renderDashboard(skipCharts) {
  skipCharts = skipCharts === true;
  // Preserve table scroll positions across re-renders (sorting resets them otherwise).
  const tableScrolls = Array.from(document.querySelectorAll(".table-container")).map((el) => ({ el, top: el.scrollTop }));

  const selectedWS = document.getElementById("workspaceSelect").value;
  const selectedModel = document.getElementById("modelSelect").value;
  const startDate = document.getElementById("startDate").value;
  let endDate = document.getElementById("endDate").value;
  if (startDate && !endDate) endDate = startDate; // Single-day selection counts as exactly that day.

  filteredRecordsCache = [];
  let totalReq = 0, totalCost = 0, totalSavings = 0, totalTokens = 0, totalPrompt = 0, totalCacheRead = 0;
  let totalPeakCost = 0, totalOffpeakCost = 0, totalFlatCost = 0;
  const dailyMap = {}, dailyTokenMap = {}, modelMap = {}, wsMap = {}, singleModelDailyMap = {}, hourlyMap = {};
  const unpricedModels = new Set();
  const rates = getRates(); // Hoisted: one read instead of one per record.

  for (const [id, rec] of Object.entries(globalCache)) {
    const wsID = rec.workspaceID || "wrk_unknown";
    const modelName = rec.model || "Unknown";
    const recDate = localDateOf(rec);

    if (startDate && recDate && recDate < startDate) continue;
    if (endDate && recDate && recDate > endDate) continue;

    if (!wsMap[wsID]) {
      wsMap[wsID] = { req: 0, tokens: 0, prompt: 0, cacheRead: 0, cost: 0 };
    }
    const { cost, savings, window, unpriced } = getRecordCostAndSavings(rec, rates);
    if (unpriced) unpricedModels.add(modelName);
    const cacheWriteTotal = (rec.cacheWrite5m || 0) + (rec.cacheWrite1h || 0);
    const tokens = (rec.input || 0) + (rec.output || 0) + (rec.reasoning || 0) + (rec.cacheRead || 0) + cacheWriteTotal;
    const promptTokens = (rec.input || 0) + (rec.cacheRead || 0);

    wsMap[wsID].req++;
    wsMap[wsID].tokens += tokens;
    wsMap[wsID].prompt += promptTokens;
    wsMap[wsID].cacheRead += (rec.cacheRead || 0);
    wsMap[wsID].cost += cost;

    if (selectedWS !== "ALL" && wsID !== selectedWS) continue;
    if (selectedModel !== "ALL" && modelName !== selectedModel) continue;

    filteredRecordsCache.push({ id, ...rec, cost, savings, tokens, window, unpriced });

    totalReq++;
    totalCost += cost;
    totalSavings += savings;
    totalTokens += tokens;
    totalPrompt += promptTokens;
    totalCacheRead += (rec.cacheRead || 0);
    if (window === "peak") totalPeakCost += cost;
    else if (window === "offpeak") totalOffpeakCost += cost;
    else if (window === "flat") totalFlatCost += cost;

    const date = localDateOf(rec);
    dailyMap[date] = (dailyMap[date] || 0) + cost;
    dailyTokenMap[date] = (dailyTokenMap[date] || 0) + tokens;

    // Minute-level buckets in local time, matching how `date` is derived (local date).
    if (rec.time && date !== "Unknown") {
      const t = new Date(rec.time);
      if (!isNaN(t.getTime())) {
        const min = t.getHours() * 60 + t.getMinutes();
        if (!hourlyMap[date]) hourlyMap[date] = {};
        const h = hourlyMap[date][min] || (hourlyMap[date][min] = { cost: 0, tokens: 0 });
        h.cost += cost;
        h.tokens += tokens;
      }
    }

    if (!singleModelDailyMap[date]) {
      singleModelDailyMap[date] = { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    }
    singleModelDailyMap[date].req++;
    singleModelDailyMap[date].input += (rec.input || 0);
    singleModelDailyMap[date].output += (rec.output || 0);
    singleModelDailyMap[date].cacheRead += (rec.cacheRead || 0);
    singleModelDailyMap[date].cost += cost;

    if (!modelMap[modelName]) {
      modelMap[modelName] = { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, peakCost: 0, offpeakCost: 0, flatCost: 0 };
    }
    modelMap[modelName].req++;
    modelMap[modelName].input += (rec.input || 0);
    modelMap[modelName].output += (rec.output || 0);
    modelMap[modelName].cacheRead += (rec.cacheRead || 0);
    modelMap[modelName].cost += cost;
    if (window === "peak") modelMap[modelName].peakCost += cost;
    else if (window === "offpeak") modelMap[modelName].offpeakCost += cost;
    else if (window === "flat") modelMap[modelName].flatCost += cost;
  }

  // Per-model average cache hit rate; exclude models with 0% (no cache reads).
  const modelHitRates = Object.values(modelMap)
    .map((m) => {
      const prompt = m.input + m.cacheRead;
      return prompt > 0 ? (m.cacheRead / prompt) * 100 : 0;
    })
    .filter((rate) => rate > 0);
  const maxHitRate = modelHitRates.length ? Math.max(...modelHitRates) : null;
  const minHitRate = modelHitRates.length ? Math.min(...modelHitRates) : null;

  document.getElementById("statRequests").innerText = totalReq.toLocaleString();
  document.getElementById("statCost").innerText = `$${fmtMoney(totalCost)}`;
  document.getElementById("statSavings").innerText = `Cache savings: $${fmtMoney(totalSavings)}`;
  document.getElementById("statTokens").innerText = totalTokens.toLocaleString();
  document.getElementById("statHitRate").innerText = totalPrompt > 0 ? `${((totalCacheRead / totalPrompt) * 100).toFixed(2)}%` : "0.00%";
  document.getElementById("statHitRateMax").innerText = maxHitRate !== null ? `Max: ${maxHitRate.toFixed(2)}%` : "Max: -";
  document.getElementById("statHitRateMin").innerText = minHitRate !== null ? `Min: ${minHitRate.toFixed(2)}%` : "Min: -";
  document.getElementById("statAvgCostPerReq").innerText = `Avg per request: $${totalReq > 0 ? fmtMoney(totalCost / totalReq, 5) : "0.00000"}`;
  document.getElementById("statAvgTokens").innerText = `Avg tokens/request: ${totalReq > 0 ? Math.round(totalTokens / totalReq).toLocaleString() : 0}`;
  const statSplit = document.getElementById("statSplit");
  if (statSplit) {
    statSplit.innerHTML =
      `<span>Peak</span><span>$${fmtMoney(totalPeakCost)}</span>` +
      `<span>Off-peak</span><span>$${fmtMoney(totalOffpeakCost)}</span>` +
      `<span>Flat</span><span>$${fmtMoney(totalFlatCost)}</span>`;
  }

  // Unpriced / incomplete model list
  const unpricedEl = document.getElementById("unpricedList");
  if (unpricedEl) {
    if (unpricedModels.size > 0) {
      unpricedEl.hidden = false;
      unpricedEl.innerHTML =
        `<strong>Unpriced models (${unpricedModels.size})</strong>:` +
        Array.from(unpricedModels).sort().map((m) => `<span class="badge">${escHTML(m)}</span>`).join(" ") +
        ` <span style="opacity:.75">— Add a matching rule in Rate Settings to price them.</span>`;
    } else {
      unpricedEl.hidden = true;
    }
  }

  let topModel = "-", maxModelCost = 0;
  for (const [m, stats] of Object.entries(modelMap)) {
    if (stats.cost > maxModelCost) {
      maxModelCost = stats.cost;
      topModel = m;
    }
  }
  document.getElementById("statTopModel").innerText = topModel;
  document.getElementById("statTopModelCost").innerText = `Cost: $${fmtMoney(maxModelCost)}`;

  // Render the per-workspace summary table (sorted by the active column).
  const wsTbody = document.getElementById("wsTableBody");
  wsTbody.innerHTML = "";
  const wsRows = Object.entries(wsMap).map(([ws, stats]) => ({
    ws,
    req: stats.req,
    tokens: stats.tokens,
    hitRate: stats.prompt > 0 ? (stats.cacheRead / stats.prompt) * 100 : 0,
    cost: stats.cost,
  }));
  for (const stats of sortBy(wsRows, sortState.ws.col, sortState.ws.dir)) {
    const hitRate = `${stats.hitRate.toFixed(2)}%`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="badge">${escHTML(stats.ws)}</span></td>
      <td>${stats.req}</td>
      <td>${stats.tokens.toLocaleString()}</td>
      <td>${hitRate}</td>
      <td><strong>$${fmtMoney(stats.cost)}</strong></td>
    `;
    wsTbody.appendChild(tr);
  }
  markSortHeader("wsTable", sortState.ws.col, sortState.ws.dir);

  // Render the model detail table.
  const tableTitle = document.getElementById("tableTitle");
  const tableHead = document.getElementById("modelTableHead");
  const tbody = document.getElementById("modelTableBody");
  tbody.innerHTML = "";

  if (selectedModel === "ALL") {
    tableTitle.innerText = "Model Details";
    tableHead.innerHTML = `
      <tr>
        <th data-col="model">Model</th>
        <th data-col="req">Requests</th>
        <th data-col="input">Input</th>
        <th data-col="output">Output</th>
        <th data-col="cacheRead">Cache Read</th>
        <th data-col="hitRate">Cache Hit Rate</th>
        <th data-col="peakCost">Peak Cost</th><th data-col="offpeakCost">Off-peak Cost</th><th data-col="flatCost">Flat Cost</th>
        <th data-col="cost">Estimated Cost</th>
      </tr>
    `;
    const modelRows = Object.entries(modelMap).map(([model, stats]) => ({
      model,
      req: stats.req,
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      hitRate: stats.input + stats.cacheRead > 0 ? (stats.cacheRead / (stats.input + stats.cacheRead)) * 100 : 0,
      peakCost: stats.peakCost,
      offpeakCost: stats.offpeakCost,
      flatCost: stats.flatCost,
      cost: stats.cost,
    }));
    for (const stats of sortBy(modelRows, sortState.model.col, sortState.model.dir)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escHTML(stats.model)}</strong></td>
        <td>${stats.req}</td>
        <td>${stats.input.toLocaleString()}</td>
        <td>${stats.output.toLocaleString()}</td>
        <td>${stats.cacheRead.toLocaleString()}</td>
        <td>${stats.hitRate.toFixed(2)}%</td>
        <td>$${fmtMoney(stats.peakCost)}</td><td>$${fmtMoney(stats.offpeakCost)}</td><td>$${fmtMoney(stats.flatCost)}</td>
        <td>$${fmtMoney(stats.cost)}</td>
      `;
      tbody.appendChild(tr);
    }
  } else {
    tableTitle.innerText = `Daily usage for "${selectedModel}"`;
    tableHead.innerHTML = `
      <tr>
        <th data-col="date">Date</th>
        <th data-col="req">Requests</th>
        <th data-col="input">Input Tokens</th>
        <th data-col="output">Output Tokens</th>
        <th data-col="cacheRead">Cache Read Tokens</th>
        <th data-col="hitRate">Cache Hit Rate</th>
        <th data-col="cost">Estimated Cost</th>
      </tr>
    `;
    const dateRows = Object.entries(singleModelDailyMap).map(([date, stats]) => ({
      date,
      req: stats.req,
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      hitRate: stats.input + stats.cacheRead > 0 ? (stats.cacheRead / (stats.input + stats.cacheRead)) * 100 : 0,
      cost: stats.cost,
    }));
    for (const stats of sortBy(dateRows, sortState.model.col, sortState.model.dir)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escHTML(stats.date)}</strong></td>
        <td>${stats.req}</td>
        <td>${stats.input.toLocaleString()}</td>
        <td>${stats.output.toLocaleString()}</td>
        <td>${stats.cacheRead.toLocaleString()}</td>
        <td>${stats.hitRate.toFixed(2)}%</td>
        <td>$${stats.cost.toFixed(4)}</td>
      `;
      tbody.appendChild(tr);
    }
  }
  markSortHeader("modelTable", sortState.model.col, sortState.model.dir);

  // Yearly heatmap ignores the date range and must always reflect the
  // current workspace/model filters — keep it outside the skipCharts guard
  // so sorting tables or any future skipCharts path can never stale it.
  renderYearlyHeatmap();

  // Draw charts (skipped when only re-sorting tables to avoid layout shifts).
  if (!skipCharts) {
  renderDailyLine(dailyMap, dailyTokenMap, hourlyMap, endDate);

  renderHourlyChart(hourlyMap, endDate);

  const models = Object.keys(modelMap);
  const modelCosts = models.map((m) => modelMap[m].cost);
  if (modelChartInst) modelChartInst.destroy();
  modelChartInst = new Chart(document.getElementById("modelChart"), {
    type: "doughnut",
    data: {
      labels: models,
      datasets: [{ data: modelCosts, backgroundColor: monoTones(modelCosts.length), borderWidth: 0, hoverBorderWidth: 0 }]
    },
    options: chartOptions({ plugins: { legend: { position: "bottom" } } })
  });

  const inputs = models.map((m) => modelMap[m].input);
  const cacheReads = models.map((m) => modelMap[m].cacheRead);
  if (tokenTypeChartInst) tokenTypeChartInst.destroy();
  tokenTypeChartInst = new Chart(document.getElementById("tokenTypeChart"), {
    type: "bar",
    data: {
      labels: models,
      datasets: [
        { label: "Real Input Tokens", data: inputs, backgroundColor: CHART_COLORS.blue },
        { label: "Cache Read Tokens", data: cacheReads, backgroundColor: CHART_COLORS.blueDim }
      ]
    },
    options: chartOptions({
      scales: {
        x: axis({ stacked: true }),
        y: axis({ stacked: true })
      }
    })
  });

  const hitRates = models.map((m) => {
    const prompt = modelMap[m].input + modelMap[m].cacheRead;
    return prompt > 0 ? parseFloat(((modelMap[m].cacheRead / prompt) * 100).toFixed(2)) : 0;
  });
  if (hitRateChartInst) hitRateChartInst.destroy();
  hitRateChartInst = new Chart(document.getElementById("hitRateChart"), {
    type: "bar",
    data: {
      labels: models,
      datasets: [{ label: "Cache Hit Rate (%)", data: hitRates, backgroundColor: CHART_COLORS.blue }]
    },
    options: chartOptions({
      scales: {
        x: axis(),
        y: axis({ max: 100 })
      }
    })
  });
  }

  // Restore table scroll positions after re-render.
  for (const { el, top } of tableScrolls) el.scrollTop = top;
}

function exportFilteredCSV() {
  if (filteredRecordsCache.length === 0) {
    alert("No filtered data to export.");
    return;
  }
  const headers = ["ID", "WorkspaceID", "Date", "Model", "Window", "Input", "Output", "Reasoning", "CacheRead", "CacheWrite5m", "CacheWrite1h", "SavingsUSD", "CostUSD"];
  const rows = [headers.join(",")];

  for (const rec of filteredRecordsCache) {
    const row = [
      rec.id,
      rec.workspaceID || "",
      localDateOf(rec),
      rec.model || "",
      rec.window || "",
      rec.input || 0,
      rec.output || 0,
      rec.reasoning || 0,
      rec.cacheRead || 0,
      rec.cacheWrite5m || 0,
      rec.cacheWrite1h || 0,
      rec.savings ? rec.savings.toFixed(6) : "0",
      rec.cost ? rec.cost.toFixed(6) : "0"
    ];
    rows.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  }

  const csvContent = "\uFEFF" + rows.join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `opencode_filtered_records.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Auto-load: merged data injected by the popup "Open Dashboard" action =====
function showEmptyStateIfNeeded() {
  if (Object.keys(globalCache).length > 0) return;
  const container = document.querySelector(".container");
  if (!container || container.querySelector(".empty-state")) return;
  const notice = document.createElement("div");
  notice.className = "notice empty-state";
  notice.innerHTML =
    `No usage data yet. Open the <strong>opencode.ai</strong> usage page and click ` +
    `<strong>Crawl Now</strong> in the extension popup to sync records.`;
  container.prepend(notice);
}

// ===== Auto-load: always pull the merged OPFS snapshot from the background =====
// The background reads OPFS directly when an opencode.ai tab is open, and falls
// back to its persistent cached snapshot otherwise - so the dashboard keeps its
// data across refreshes forever, without any manual import.
async function loadFromExtension() {
  // Mirror the current rate config into chrome.storage so the popup's time
  // reminder can read the peak windows even before the user opens Rate Settings.
  try {
    chrome.storage.local.set({ [TIME_RATES_KEY]: getRates() });
  } catch (e) {}
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      showEmptyStateIfNeeded();
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "get-dashboard-data" });
    if (!res || !res.ok || !res.data) {
      showEmptyStateIfNeeded();
      return;
    }

    const data = JSON.parse(res.data);
    for (const [id, rec] of Object.entries(data)) {
      globalCache[id] = rec;
    }
    initDateRange();
    updateDropdowns();
    renderDashboard();
    showEmptyStateIfNeeded();

    const container = document.querySelector(".container");
    if (container && Object.keys(data).length > 0) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.innerHTML =
        `Loaded <strong style="color:var(--success)">` +
        `${Object.keys(data).length.toLocaleString()} records</strong> from OPFS` +
        (res.fromCache ? ` <span style="opacity:.75">(cached snapshot)</span>.` : ".");
      container.prepend(notice);
    }
  } catch (e) {
    console.error("Failed to load data", e);
    showEmptyStateIfNeeded();
  }
}

// ===== Rate settings modal =====
const escAttr = (v) => String(v ?? "").replace(/"/g, "&quot;");

// datetime-local ↔ UTC ISO conversion: stored as UTC ISO, input in local time
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Plain number input: type value directly, no spinner buttons
const numField = (cls, label, value, step = "0.1") =>
  `<label class="nf">${label}<input class="${cls}" type="number" step="${step}" value="${value}"></label>`;

// Price table (optional tier: low/high by input+cacheRead total context)
function priceTableHTML(prefix, table) {
  const t = table && table.tier;
  const flat = table && !table.tier ? table : {};
  const low = (t && t.low) || {};
  const high = (t && t.high) || {};
  const group = (title, inner) => `<div class="rate-group"><span class="rate-group-title">${title}</span>${inner}</div>`;
  return `
    <div class="price-table">
      <label class="pt-tier-toggle"><input type="checkbox" class="pt-has-tier" ${t ? "checked" : ""}> Tier</label>
      <div class="pt-tier" ${t ? "" : "hidden"}>
        ${group("Tier", numField(`${prefix}-tier-limit`, "&le;Limit", (t && t.limit) ?? 0, "1"))}
        ${group("Low",
          numField(`${prefix}-tier-low-input`, "In", low.input ?? 0) +
          numField(`${prefix}-tier-low-output`, "Out", low.output ?? 0) +
          numField(`${prefix}-tier-low-cr`, "CR", low.cacheRead ?? 0) +
          numField(`${prefix}-tier-low-cw`, "CW", low.cacheWrite ?? 0))}
        ${group("High",
          numField(`${prefix}-tier-high-input`, "In", high.input ?? 0) +
          numField(`${prefix}-tier-high-output`, "Out", high.output ?? 0) +
          numField(`${prefix}-tier-high-cr`, "CR", high.cacheRead ?? 0) +
          numField(`${prefix}-tier-high-cw`, "CW", high.cacheWrite ?? 0))}
      </div>
      <div class="pt-flat" ${t ? "hidden" : ""}>
        ${numField(`${prefix}-input`, "In", flat.input ?? 0) +
          numField(`${prefix}-output`, "Out", flat.output ?? 0) +
          numField(`${prefix}-cr`, "CR", flat.cacheRead ?? 0) +
          numField(`${prefix}-cw`, "CW", flat.cacheWrite ?? 0)}
      </div>
    </div>`;
}

// Peak window rows (off-peak is the complement, no need to fill)
// Weekdays use toggle buttons (0=Sun … 6=Sat), no need to memorize numeric codes.
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function windowRowHTML(w) {
  const days = w && w.days && w.days.length > 0 ? w.days : [0, 1, 2, 3, 4, 5, 6]; // Default: every day
  const dayToggles = DAY_LABELS.map((label, i) =>
    `<label class="rv-day"><input type="checkbox" class="rv-window-day" value="${i}" ${days.includes(i) ? "checked" : ""}>${label}</label>`
  ).join("");
  return `
    <div class="rv-window">
      <span class="rv-window-days">${dayToggles}</span>
      <input type="time" class="rv-window-start" value="${escAttr((w && w.start) || "")}">
      <input type="time" class="rv-window-end" value="${escAttr((w && w.end) || "")}">
      <button type="button" class="rv-window-del" aria-label="Remove window">&times;</button>
    </div>`;
}

// Single rate version
// Each version uses a unique uid for the class prefix (data-prefix) to avoid index misalignment after deleting versions.
let versionUid = 0;
function rateVersionHTML(entry, idx) {
  const mode = entry.windows && entry.windows.peak && entry.windows.peak.length > 0 ? "time" : "flat";
  const windows = (entry.windows && entry.windows.peak) || [];
  const uid = "rv" + (++versionUid);
  const fromLocal = toLocalInput(entry.from);
  const fromLabel = fromLocal ? fromLocal.replace("T", " ") : "earliest";
  return `
    <div class="rate-version" data-mode="${mode}" data-prefix="${uid}">
      <div class="rv-head">
        <span class="rv-title">Version ${idx + 1} · effective from ${fromLabel}</span>
        <button type="button" class="rv-del">Del</button>
      </div>
      <div class="rv-dates">
        <label>Effective from
          <div class="dt-picker">
            <button type="button" class="input range-trigger dt-trigger" title="Pick effective-from date & time">
              <span class="dt-label">${fromLabel}</span>
              <span class="range-caret">▾</span>
            </button>
            <input type="hidden" class="rv-from" value="${escAttr(fromLocal)}">
            <div class="range-popup dt-popup" hidden>
              <div class="range-cal-head">
                <button type="button" class="range-nav dt-prev" title="Previous month">‹</button>
                <span class="dt-month-label">…</span>
                <button type="button" class="range-nav dt-next" title="Next month">›</button>
              </div>
              <div class="range-weekdays dt-weekdays"></div>
              <div class="range-days dt-days"></div>
              <div class="dt-time">
                <span class="dt-time-label">Time</span>
                <div class="dt-stepper">
                  <button type="button" class="dt-step-up" data-field="hour" tabindex="-1" title="Hour up">▲</button>
                  <input type="number" class="dt-hour" min="0" max="23" placeholder="HH" inputmode="numeric">
                  <button type="button" class="dt-step-down" data-field="hour" tabindex="-1" title="Hour down">▼</button>
                </div>
                <span class="dt-colon">:</span>
                <div class="dt-stepper">
                  <button type="button" class="dt-step-up" data-field="minute" tabindex="-1" title="Minute up">▲</button>
                  <input type="number" class="dt-minute" min="0" max="59" placeholder="MM" inputmode="numeric">
                  <button type="button" class="dt-step-down" data-field="minute" tabindex="-1" title="Minute down">▼</button>
                </div>
              </div>
              <div class="range-actions">
                <button type="button" class="btn btn-secondary dt-clear">Earliest</button>
                <button type="button" class="btn btn-primary dt-apply">Apply</button>
              </div>
            </div>
          </div>
        </label>
      </div>
      <div class="rv-mode">
        <label>Mode
          <select class="rv-mode-select">
            <option value="flat" ${mode === "flat" ? "selected" : ""}>Flat</option>
            <option value="time" ${mode === "time" ? "selected" : ""}>Time-based</option>
          </select>
        </label>
      </div>
      <div class="rv-flat-section" ${mode === "flat" ? "" : "hidden"}>
        ${priceTableHTML(`${uid}-flat`, entry.pricing && entry.pricing.flat)}
      </div>
      <div class="rv-time-section" ${mode === "time" ? "" : "hidden"}>
        <div class="rv-windows">
          <div class="rv-windows-title">Peak Windows (off-peak = remaining time)</div>
          ${windows.map((w) => windowRowHTML(w)).join("")}
          <button type="button" class="rv-window-add">+ Peak Window</button>
        </div>
        <div class="rv-tables">
          <div class="rv-table-block">
            <div class="rv-table-title">Peak</div>
            ${priceTableHTML(`${uid}-peak`, entry.pricing && entry.pricing.peak)}
          </div>
          <div class="rv-table-block">
            <div class="rv-table-title">Off-peak</div>
            ${priceTableHTML(`${uid}-offpeak`, entry.pricing && entry.pricing.offpeak)}
          </div>
        </div>
      </div>
    </div>`;
}

// Single rule (exact model name + list of rate versions)
function rateRowHTML(rule) {
  const rates = rule.rates && rule.rates.length > 0 ? rule.rates : [{ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }];
  return `
    <div class="rate-row">
      <div class="rate-main">
        <input class="rate-model" value="${escAttr(rule.model || "")}" placeholder="Model name (exact)">
        <button class="rate-del">Del</button>
      </div>
      <div class="rate-versions">
        ${rates.map((e, i) => rateVersionHTML(e, i)).join("")}
      </div>
      <button type="button" class="rv-add-version">+ Add Rate Version</button>
    </div>`;
}

// Mode switch: flat / time-based
function wireModeSelect(select) {
  select.addEventListener("change", () => {
    const version = select.closest(".rate-version");
    const mode = select.value;
    version.dataset.mode = mode;
    version.querySelector(".rv-flat-section").hidden = mode !== "flat";
    version.querySelector(".rv-time-section").hidden = mode !== "time";
  });
}

// Tier toggle: checked shows low/high, unchecked shows a single price
function wireTierToggle(checkbox) {
  checkbox.addEventListener("change", () => {
    const pt = checkbox.closest(".price-table");
    pt.querySelector(".pt-tier").hidden = !checkbox.checked;
    pt.querySelector(".pt-flat").hidden = checkbox.checked;
  });
}

function wireDelete(btn) {
  btn.addEventListener("click", () => btn.closest(".rate-row").remove());
}

function wireVersionDel(btn) {
  btn.addEventListener("click", () => btn.closest(".rate-version").remove());
}

function wireWindowDel(btn) {
  btn.addEventListener("click", () => btn.closest(".rv-window").remove());
}

function wireWindowAdd(btn) {
  btn.addEventListener("click", () => {
    btn.insertAdjacentHTML("beforebegin", windowRowHTML({}));
    const row = btn.previousElementSibling;
    wireWindowDel(row.querySelector(".rv-window-del"));
  });
}

function wireVersionAdd(btn) {
  btn.addEventListener("click", () => {
    const versions = btn.closest(".rate-row").querySelector(".rate-versions");
    versions.insertAdjacentHTML("beforeend", rateVersionHTML({ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, versions.children.length));
    const version = versions.lastElementChild;
    wireVersionControls(version);
  });
}

function wireVersionControls(version) {
  wireModeSelect(version.querySelector(".rv-mode-select"));
  wireVersionDel(version.querySelector(".rv-del"));
  version.querySelectorAll(".pt-has-tier").forEach(wireTierToggle);
  version.querySelectorAll(".rv-window-del").forEach(wireWindowDel);
  version.querySelectorAll(".rv-window-add").forEach(wireWindowAdd);
  version.querySelectorAll(".dt-picker").forEach(initDtPicker);
}

// ===== Single date+time picker (rate "effective from") =====
// Same look as the date-range picker; writes "YYYY-MM-DDTHH:mm" (local) into a hidden .rv-from input.
let openDtPicker = null;

function closeDtPickers() {
  if (openDtPicker && openDtPicker._dtClose) openDtPicker._dtClose();
}

function initDtPicker(picker) {
  const trigger = picker.querySelector(".dt-trigger");
  const label = picker.querySelector(".dt-label");
  const popup = picker.querySelector(".dt-popup");
  const hidden = picker.querySelector(".rv-from");
  const monthLabel = popup.querySelector(".dt-month-label");
  const weekdaysEl = popup.querySelector(".dt-weekdays");
  const daysEl = popup.querySelector(".dt-days");
  const hourInput = popup.querySelector(".dt-hour");
  const minuteInput = popup.querySelector(".dt-minute");

  const state = { date: "", hour: 0, minute: 0, viewYear: null, viewMonth: null };

  function parseValue() {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(hidden.value || "");
    if (m) { state.date = m[1]; state.hour = +m[2]; state.minute = +m[3]; }
    else { state.date = ""; state.hour = 0; state.minute = 0; }
  }

  function updateLabel() {
    label.textContent = state.date
      ? `${state.date} ${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}`
      : "earliest";
  }

  function renderCalendar() {
    monthLabel.textContent =
      new Date(state.viewYear, state.viewMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    renderCalendarGrid(weekdaysEl, daysEl, state.viewYear, state.viewMonth, (btn) => {
      if (btn.dataset.date === state.date) btn.classList.add("range-start", "range-end");
    }, (iso) => {
      state.date = iso;
      renderCalendar();
    });
  }

  function shiftMonth(delta) {
    shiftViewMonth(state, delta);
    renderCalendar();
  }

  function open() {
    closeDtPickers();
    parseValue();
    if (state.viewYear === null) {
      const ref = state.date || todayISO();
      state.viewYear = +ref.slice(0, 4);
      state.viewMonth = +ref.slice(5, 7) - 1;
    }
    hourInput.value = state.date ? String(state.hour).padStart(2, "0") : "";
    minuteInput.value = state.date ? String(state.minute).padStart(2, "0") : "";
    renderCalendar();
    // Fixed positioning so the popup is never clipped by the scrollable rates list.
    const rect = trigger.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 310)) + "px";
    if (rect.bottom + 330 + 8 > window.innerHeight) {
      popup.style.top = "auto";
      popup.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    } else {
      popup.style.bottom = "auto";
      popup.style.top = (rect.bottom + 6) + "px";
    }
    popup.hidden = false;
    trigger.classList.add("open");
    openDtPicker = picker;
  }

  function close() {
    popup.hidden = true;
    trigger.classList.remove("open");
    if (openDtPicker === picker) openDtPicker = null;
  }

  function apply() {
    if (state.date) {
      const h = Math.min(23, Math.max(0, parseInt(hourInput.value, 10) || 0));
      const m = Math.min(59, Math.max(0, parseInt(minuteInput.value, 10) || 0));
      state.hour = h; state.minute = m;
      hidden.value = `${state.date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    } else {
      hidden.value = "";
    }
    updateLabel();
    close();
  }

  function clear() {
    state.date = "";
    hidden.value = "";
    updateLabel();
    close();
  }

  // Stepper: ▲/▼ adjust hour/minute with wraparound; typing still allowed.
  function stepField(field, delta) {
    const input = field === "hour" ? hourInput : minuteInput;
    const max = field === "hour" ? 23 : 59;
    let v = parseInt(input.value, 10);
    if (isNaN(v)) v = 0;
    v = (v + delta + max + 1) % (max + 1);
    input.value = String(v).padStart(2, "0");
    if (field === "hour") state.hour = v; else state.minute = v;
  }

  picker._dtClose = close;
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!popup.hidden) { close(); return; }
    open();
  });
  popup.addEventListener("click", (e) => e.stopPropagation());
  popup.querySelector(".dt-prev").addEventListener("click", () => shiftMonth(-1));
  popup.querySelector(".dt-next").addEventListener("click", () => shiftMonth(1));
  popup.querySelector(".dt-clear").addEventListener("click", clear);
  popup.querySelector(".dt-apply").addEventListener("click", apply);
  popup.querySelectorAll(".dt-step-up").forEach((b) => b.addEventListener("click", () => stepField(b.dataset.field, 1)));
  popup.querySelectorAll(".dt-step-down").forEach((b) => b.addEventListener("click", () => stepField(b.dataset.field, -1)));

  updateLabel();
}

function renderRateList() {
  const list = document.getElementById("ratesList");
  list.innerHTML = getRates().map((r) => rateRowHTML(r)).join("");
  list.querySelectorAll(".rate-del").forEach(wireDelete);
  list.querySelectorAll(".rv-add-version").forEach(wireVersionAdd);
  list.querySelectorAll(".rate-version").forEach(wireVersionControls);
}

// Collect rate settings from the DOM (with structural validation)
function collectRates() {
  const rules = [];
  document.querySelectorAll("#ratesList .rate-row").forEach((row, idx) => {
    const model = row.querySelector(".rate-model").value.trim();
    // Keep rules with empty model so validateRates can catch and report them (don't silently drop)
    const num = (el) => parseFloat(el.value) || 0;
    const rates = [];
    row.querySelectorAll(".rate-version").forEach((version) => {
      const mode = version.dataset.mode || "flat";
      const prefix = version.dataset.prefix || "rv0"; // Unique prefix to avoid index misalignment after deleting versions
      const from = fromLocalInput(version.querySelector(".rv-from").value);
      const readTable = (p) => {
        const hasTier = version.querySelector(`.${p}-tier-limit`) !== null &&
          !version.querySelector(`.${p}-tier-limit`).closest(".pt-tier").hidden;
        if (hasTier) {
          return {
            tier: {
              limit: num(version.querySelector(`.${p}-tier-limit`)),
              low: {
                input: num(version.querySelector(`.${p}-tier-low-input`)),
                output: num(version.querySelector(`.${p}-tier-low-output`)),
                cacheRead: num(version.querySelector(`.${p}-tier-low-cr`)),
                cacheWrite: num(version.querySelector(`.${p}-tier-low-cw`)),
              },
              high: {
                input: num(version.querySelector(`.${p}-tier-high-input`)),
                output: num(version.querySelector(`.${p}-tier-high-output`)),
                cacheRead: num(version.querySelector(`.${p}-tier-high-cr`)),
                cacheWrite: num(version.querySelector(`.${p}-tier-high-cw`)),
              },
            },
          };
        }
        return {
          input: num(version.querySelector(`.${p}-input`)),
          output: num(version.querySelector(`.${p}-output`)),
          cacheRead: num(version.querySelector(`.${p}-cr`)),
          cacheWrite: num(version.querySelector(`.${p}-cw`)),
        };
      };
      const entry = { from };
      if (mode === "time") {
        const windows = [];
        version.querySelectorAll(".rv-window").forEach((w) => {
          let days = Array.from(w.querySelectorAll(".rv-window-day:checked")).map((c) => parseInt(c.value, 10));
          if (days.length === 0) days = [0, 1, 2, 3, 4, 5, 6]; // None checked = every day
          const start = w.querySelector(".rv-window-start").value.trim();
          const end = w.querySelector(".rv-window-end").value.trim();
          if (start && end) windows.push({ days, start, end });
        });
        entry.windows = { peak: windows };
        entry.pricing = {
          peak: readTable(`${prefix}-peak`),
          offpeak: readTable(`${prefix}-offpeak`),
        };
      } else {
        entry.pricing = { flat: readTable(`${prefix}-flat`) };
      }
      rates.push(entry);
    });
    rules.push({ id: `r${Date.now()}_${idx}`, model, rates });
  });
  return rules;
}

// Structural validation: model required, at least one version, unique effective-from dates, complete price tables
function validateRates(models) {
  const errors = [];
  for (const rule of models) {
    if (!rule.model) { errors.push("A rule is missing a model name"); continue; }
    if (!rule.rates || rule.rates.length === 0) { errors.push(`${rule.model} needs at least one rate version`); continue; }
    // Effective-from dates must be unique (same from = ambiguous which version applies)
    const seen = new Map();
    for (let i = 0; i < rule.rates.length; i++) {
      const from = parseBound(rule.rates[i].from);
      const key = from === null ? "null" : String(from);
      if (seen.has(key)) {
        errors.push(`${rule.model} versions ${seen.get(key) + 1} and ${i + 1} have the same effective-from time`);
      } else {
        seen.set(key, i);
      }
    }
    for (const entry of rule.rates) {
      const pricing = entry.pricing || {};
      const mode = entry.windows && entry.windows.peak && entry.windows.peak.length > 0 ? "time" : "flat";
      if (mode === "flat") {
        if (!pricing.flat) errors.push(`${rule.model} version is missing the flat price table`);
      } else {
        if (!pricing.peak || !pricing.offpeak) errors.push(`${rule.model} version is missing the peak/offpeak price tables`);
      }
    }
  }
  return errors;
}

function openRatesModal() {
  renderRateList();
  document.getElementById("ratesModal").style.display = "flex";
}

function closeRatesModal() {
  closeDtPickers();
  document.getElementById("ratesModal").style.display = "none";
}

// ===== JSON import / export =====
function exportRatesJSON() {
  const cfg = { version: RATES_VERSION, timezone: "UTC", models: getRates() };
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "opencode_model_rates.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importRatesJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const cfg = JSON.parse(reader.result);
      const models = Array.isArray(cfg) ? cfg : cfg.models;
      if (!Array.isArray(models) || models.length === 0) throw new Error("Invalid config");
      const errors = validateRates(models);
      if (errors.length > 0) {
        alert("Imported settings have issues:\n" + errors.join("\n"));
        return;
      }
      saveRates(models);
      renderRateList();
      renderDashboard();
      alert(`Imported ${models.length} rules`);
    } catch (e) {
      alert("Import failed: not a valid JSON config");
    }
  };
  reader.readAsText(file);
}

// ===== Event wiring (MV3 CSP forbids inline handlers) =====
document.getElementById("btnExportCSV").addEventListener("click", exportFilteredCSV);

// Sortable table headers: click toggles ascending/descending on the column.
document.addEventListener("click", (e) => {
  const th = e.target.closest("th[data-col]");
  if (!th) return;
  const tableId = th.closest("table").id;
  const state = tableId === "wsTable" ? sortState.ws : sortState.model;
  const col = th.dataset.col;
  if (state.col === col) state.dir = -state.dir;
  else {
    state.col = col;
    state.dir = -1;
  }
  renderDashboard(true); // Skip chart re-render so the viewport doesn't jump.
});
document.getElementById("btnRates").addEventListener("click", openRatesModal);
document.getElementById("ratesClose").addEventListener("click", closeRatesModal);
document.getElementById("ratesModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeRatesModal();
});
document.getElementById("ratesAdd").addEventListener("click", () => {
  const list = document.getElementById("ratesList");
  list.insertAdjacentHTML("beforeend", rateRowHTML({ model: "", rates: [{ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] }));
  const row = list.lastElementChild;
  wireDelete(row.querySelector(".rate-del"));
  wireVersionAdd(row.querySelector(".rv-add-version"));
  wireVersionControls(row.querySelector(".rate-version"));
});
document.getElementById("ratesSave").addEventListener("click", () => {
  const models = collectRates();
  const errors = validateRates(models);
  if (errors.length > 0) {
    alert("Cannot save:\n" + errors.join("\n"));
    return;
  }
  saveRates(models);
  closeRatesModal();
  renderDashboard();
});
document.getElementById("ratesReset").addEventListener("click", () => {
  localStorage.removeItem(RATES_KEY);
  try {
    chrome.storage.local.set({ [TIME_RATES_KEY]: getRates() });
  } catch (e) {}
  renderRateList();
});
document.getElementById("ratesExport").addEventListener("click", exportRatesJSON);
document.getElementById("ratesImport").addEventListener("click", () => {
  document.getElementById("ratesImportFile").click();
});
document.getElementById("ratesImportFile").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importRatesJSON(file);
  e.target.value = "";
});
document.getElementById("workspaceSelect").addEventListener("change", () => renderDashboard());
document.getElementById("modelSelect").addEventListener("change", () => renderDashboard());

// Intraday chart view switcher.
document.querySelectorAll(".hourly-view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    hourlyView = btn.dataset.view;
    document.querySelectorAll(".hourly-view-btn").forEach((b) => {
      b.classList.toggle("btn-primary", b === btn);
      b.classList.toggle("btn-secondary", b !== btn);
    });
    renderHourlyChart(lastHourlyMap, lastHourlyDate);
  });
});

// Custom date range picker
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
document.addEventListener("click", (e) => {
  if (openDtPicker && !e.target.closest(".dt-picker")) closeDtPickers();
});

loadFromExtension();

// ===== Time reminder =====
const timeStatusEl = document.getElementById("time-status");
const timeCountdownEl = document.getElementById("time-countdown");
const timeLocalEl = document.getElementById("time-local");
const timeUtcEl = document.getElementById("time-utc");
const timeTimelineEl = document.getElementById("time-timeline");
const timeToggleEl = document.getElementById("time-toggle");
const timeModelEl = document.getElementById("time-model");

let timeSelectedModel = "";
// Cached peak windows for the selected model. Rebuilt only when the model or
// the rate config changes, so the per-second render never re-parses rates.
let timePeakWindows = [];

function refreshTimePeakWindows() {
  timePeakWindows = collectPeakWindowsForModel(getRates(), timeSelectedModel);
}

function renderTimeReminder() {
  const now = new Date();
  timeLocalEl.textContent = formatLocalTime(now);
  timeUtcEl.textContent = formatUtcTime(now);

  const peak = isPeakAt(now, timePeakWindows);
  const hasWindows = timePeakWindows.length > 0;

  timeStatusEl.className = "time-status " + (hasWindows ? (peak ? "peak" : "offpeak") : "flat");
  timeStatusEl.textContent = hasWindows ? (peak ? "PEAK" : "OFF-PEAK") : "NO RATES";

  const timeline = buildTimeline(timePeakWindows);
  const nowHour = now.getHours();
  timeTimelineEl.innerHTML = timeline
    .map((seg) => `<div class="seg ${seg.peak ? "peak" : ""} ${seg.hour === nowHour ? "now" : ""}" title="${String(seg.hour).padStart(2, "0")}:00"></div>`)
    .join("");

  // Countdown to the next peak boundary (start or end), ticking every second
  if (hasWindows) {
    timeCountdownEl.className = "time-countdown " + (peak ? "peak" : "offpeak");
    const boundary = nextPeakBoundary(now, timePeakWindows);
    timeCountdownEl.textContent = boundary ? formatCountdownClock(boundary.time - now) : "--:--:--";
  } else {
    timeCountdownEl.className = "time-countdown flat";
    timeCountdownEl.textContent = "NO RATES";
  }
}

function populateTimeModels() {
  const models = listPeakModels(getRates());
  timeModelEl.innerHTML =
    '<option value="">Select model</option>' + models.map((m) => `<option value="${m}">${m}</option>`).join("");
  return models;
}

async function initTimeReminder() {
  timeToggleEl.checked = await loadTimeEnabled();
  timeToggleEl.addEventListener("change", () => saveTimeEnabled(timeToggleEl.checked));

  const models = populateTimeModels();
  let selected = await loadTimeModel();
  if (!models.includes(selected)) selected = models[0] || "";
  timeModelEl.value = selected;
  timeSelectedModel = selected;
  refreshTimePeakWindows();

  timeModelEl.addEventListener("change", () => {
    timeSelectedModel = timeModelEl.value;
    saveTimeModel(timeModelEl.value);
    refreshTimePeakWindows();
    renderTimeReminder();
  });

  // Rebuild the cached peak windows whenever the rate config is mirrored into
  // chrome.storage (i.e. after Rate Settings are saved/reset/imported).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[TIME_RATES_KEY]) {
      refreshTimePeakWindows();
      renderTimeReminder();
    }
  });

  renderTimeReminder();
  setInterval(renderTimeReminder, 1000);
}

// ===== Neural network background (decorative) — always on =====
let _neuralRAF = 0;
let _neuralLayers = [];
let _neuralEdges = [];
let _neuralHighlights = [];
let _neuralW = 0, _neuralH = 0;
let _neuralNextHL = 0;



function buildNeuralGraph() {
  const xs = [0.03, 0.16, 0.30, 0.44, 0.60, 0.78, 0.97];
  const counts = [5, 7, 10, 13, 10, 7, 5];
  _neuralLayers = xs.map((xf, li) => {
    const n = counts[li];
    const isCenter = li === 3;
    const isEdge = li === 0 || li === 6;
    return Array.from({ length: n }, (_, i) => ({
      x: xf * _neuralW,
      baseX: xf * _neuralW,
      baseY: ((i + 1) / (n + 1)) * _neuralH,
      y: 0,
      phase: Math.random() * Math.PI * 2,
      driftPhase: Math.random() * Math.PI * 2,
      driftSpeed: 0.22 + Math.random() * 0.32,
      driftAmpX: 18 + Math.random() * 16,
      driftAmpY: 16 + Math.random() * 16,
      r: isCenter ? 2.6 : isEdge ? 1.4 : 1.9,
    }));
  });
  _neuralEdges = [];
  for (let li = 0; li < _neuralLayers.length - 1; li++) {
    const keepProb = li === 3 ? 0.78 : li === 2 || li === 4 ? 0.68 : 0.52;
    for (let a = 0; a < _neuralLayers[li].length; a++) {
      for (let b = 0; b < _neuralLayers[li + 1].length; b++) {
        if (Math.random() > keepProb) continue;
        _neuralEdges.push({ li, a, b, skip: false });
      }
    }
  }
  for (let li = 0; li < _neuralLayers.length - 2; li++) {
    for (let k = 0; k < 2; k++) {
      const a = Math.floor(Math.random() * _neuralLayers[li].length);
      const b = Math.floor(Math.random() * _neuralLayers[li + 2].length);
      _neuralEdges.push({ li, a, b, skip: true });
    }
  }
  _neuralHighlights = [];
  _neuralNextHL = performance.now() + 300;
}

function startNeural() {
  const canvas = document.getElementById("neuralCanvas");
  if (!canvas) return;
  stopNeural();
  resizeNeural();
  buildNeuralGraph();
  window.addEventListener("resize", onNeuralResize);
  tickNeural();
}

function stopNeural() {
  if (_neuralRAF) cancelAnimationFrame(_neuralRAF);
  _neuralRAF = 0;
  window.removeEventListener("resize", onNeuralResize);
}

function onNeuralResize() { resizeNeural(); buildNeuralGraph(); }

function resizeNeural() {
  const canvas = document.getElementById("neuralCanvas");
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  _neuralW = window.innerWidth;
  _neuralH = window.innerHeight;
  canvas.width = Math.floor(_neuralW * dpr);
  canvas.height = Math.floor(_neuralH * dpr);
  canvas.style.width = _neuralW + "px";
  canvas.style.height = _neuralH + "px";
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

let _neuralRecentPaths = [];
function spawnHighlight(now) {
  if (now < _neuralNextHL) return;
  _neuralNextHL = now + 650 + Math.random() * 1100;
  let aIdx, pathKey, tries = 0;
  do {
    aIdx = Math.floor(Math.random() * _neuralLayers[0].length);
    let tmp = aIdx, key = String(aIdx);
    for (let li = 0; li < _neuralLayers.length - 1; li++) {
      const curY = _neuralLayers[li][tmp].baseY;
      let pool = [];
      for (let b = 0; b < _neuralLayers[li + 1].length; b++) pool.push(b);
      pool.sort(() => Math.random() - 0.5);
      let best = pool[0], bestScore = Infinity;
      for (const b of pool.slice(0, 4)) {
        const d = Math.abs(_neuralLayers[li + 1][b].baseY - curY) + Math.random() * 36;
        if (d < bestScore) { bestScore = d; best = b; }
      }
      tmp = best; key += "-" + tmp;
    }
    pathKey = key;
    tries++;
  } while (_neuralRecentPaths.includes(pathKey) && tries < 8);
  _neuralRecentPaths.push(pathKey);
  if (_neuralRecentPaths.length > 6) _neuralRecentPaths.shift();
  for (let li = 0; li < _neuralLayers.length - 1; li++) {
    const curY = _neuralLayers[li][aIdx].baseY;
    let pool = [];
    for (let b = 0; b < _neuralLayers[li + 1].length; b++) pool.push(b);
    pool.sort(() => Math.random() - 0.5);
    let best = pool[0], bestScore = Infinity;
    for (const b of pool.slice(0, 4)) {
      const d = Math.abs(_neuralLayers[li + 1][b].baseY - curY) + Math.random() * 36;
      if (d < bestScore) { bestScore = d; best = b; }
    }
    _neuralHighlights.push({ li, a: aIdx, b: best, life: 0, maxLife: 420 + Math.random() * 280 });
    aIdx = best;
  }
}

function tickNeural() {
  const canvas = document.getElementById("neuralCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const now = performance.now();
  const tSec = now * 0.001;
  ctx.clearRect(0, 0, _neuralW, _neuralH);
  const glow = ctx.createRadialGradient(_neuralW * 0.5, _neuralH * 0.18, 0, _neuralW * 0.5, _neuralH * 0.18, _neuralW * 0.85);
  glow.addColorStop(0, "rgba(106,143,192,0.07)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, _neuralW, _neuralH);

  for (const layer of _neuralLayers) {
    for (const n of layer) {
      n.x = n.baseX + Math.sin(tSec * n.driftSpeed + n.driftPhase) * n.driftAmpX + Math.cos(tSec * n.driftSpeed * 0.62 + n.driftPhase * 1.3) * n.driftAmpX * 0.35;
      n.y = n.baseY + Math.sin(tSec * 0.55 + n.phase) * 7 + Math.cos(tSec * n.driftSpeed * 0.71 + n.driftPhase * 0.9) * n.driftAmpY * 0.5;
    }
  }

  spawnHighlight(now);

  for (const e of _neuralEdges) {
    const a = _neuralLayers[e.li][e.a];
    const bLayer = e.skip ? _neuralLayers[e.li + 2] : _neuralLayers[e.li + 1];
    const b = bLayer[e.b];
    if (!a || !b) continue;
    const alpha = e.skip ? 0.028 : 0.095;
    ctx.strokeStyle = `rgba(106,143,192,${alpha})`;
    ctx.lineWidth = e.skip ? 0.6 : 0.75;
    ctx.beginPath();
    if (e.skip) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - 18;
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
    } else {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  // thinking highlight: pulse a whole path, line glow only (no flying dot)
  for (let i = _neuralHighlights.length - 1; i >= 0; i--) {
    const h = _neuralHighlights[i];
    h.life += 16;
    if (h.life > h.maxLife) { _neuralHighlights.splice(i, 1); continue; }
    const a = _neuralLayers[h.li][h.a];
    const b = _neuralLayers[h.li + 1][h.b];
    if (!a || !b) continue;
    const p = h.life / h.maxLife; // 0..1
    const env = p < 0.15 ? p / 0.15 : p > 0.75 ? (1 - p) / 0.25 : 1; // attack + release
    ctx.strokeStyle = `rgba(130,170,255,${(0.52 * env).toFixed(3)})`;
    ctx.lineWidth = 1.7;
    ctx.shadowColor = "rgba(106,143,192,0.95)";
    ctx.shadowBlur = 11;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(190,210,255,${(0.22 * env).toFixed(3)})`;
    ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  for (let li = 0; li < _neuralLayers.length; li++) {
    for (let i = 0; i < _neuralLayers[li].length; i++) {
      const n = _neuralLayers[li][i];
      const pulse = 0.55 + 0.45 * Math.sin(tSec * 1.35 + n.phase * 1.7);
      const hl = _neuralHighlights.find((h) => (h.li === li && h.a === i) || (h.li === li - 1 && h.b === i));
      const env = hl ? (() => { const p = hl.life / hl.maxLife; return p < 0.15 ? p / 0.15 : p > 0.75 ? (1 - p) / 0.25 : 1; })() : 0;
      const isActive = env > 0.08;
      const baseA = isActive ? 0.32 + env * 0.18 : 0.18;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(106,143,192,${(baseA + pulse * 0.12).toFixed(3)})`;
      ctx.fill();
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(106,143,192,${(0.035 * pulse).toFixed(3)})`;
      ctx.fill();
      if (isActive) {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2.2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(130,170,255,${(0.35 + env * 0.25).toFixed(2)})`;
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
    }
  }

  _neuralRAF = requestAnimationFrame(tickNeural);
}

function initDecorBg() {
  startNeural();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (_neuralRAF) cancelAnimationFrame(_neuralRAF); _neuralRAF = 0; }
    else if (!_neuralRAF) tickNeural();
  });
}

initTimeReminder();
initDecorBg();
