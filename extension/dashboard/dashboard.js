// dashboard.js - Same logic as the original opencode_dashboard.html, but the data is
// injected automatically by the extension. MV3 page CSP forbids inline scripts/handlers,
// so all events are wired here.

const globalCache = {};
let filteredRecordsCache = [];

let dailyChartInst = null;
let modelChartInst = null;
let tokenTypeChartInst = null;
let workspaceChartInst = null;
let hitRateChartInst = null;

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
    if (rec.date && rec.date !== "Unknown") dates.push(rec.date);
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

  // Weekday header row (Su..Sa).
  const weekdaysEl = document.getElementById("rangeWeekdays");
  weekdaysEl.innerHTML = "";
  for (const w of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) {
    const span = document.createElement("span");
    span.textContent = w;
    weekdaysEl.appendChild(span);
  }

  const daysEl = document.getElementById("rangeDays");
  daysEl.innerHTML = "";

  const startWeekday = new Date(rangePicker.viewYear, rangePicker.viewMonth, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(rangePicker.viewYear, rangePicker.viewMonth + 1, 0).getDate();
  const today = todayISO();
  // A start-only selection means a single day, so highlight it as start = end.
  const start = rangePicker.start;
  const end = rangePicker.end || rangePicker.start;

  for (let i = 0; i < startWeekday; i++) daysEl.appendChild(document.createElement("div"));

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${rangePicker.viewYear}-${String(rangePicker.viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "range-day";
    btn.textContent = day;
    btn.title = iso;
    btn.dataset.date = iso;
    if (iso === today) btn.classList.add("today");
    if (iso === start) btn.classList.add("range-start");
    if (iso === end) btn.classList.add("range-end");
    if (start && end && iso >= start && iso <= end) btn.classList.add("in-range");
    btn.addEventListener("click", (e) => {
      // Stop propagation so re-rendering (which detaches this button) can't
      // make the document-level click handler misread it as an outside click.
      e.stopPropagation();
      onRangeDayClick(iso);
    });
    daysEl.appendChild(btn);
  }
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
  rangePicker.viewMonth += delta;
  if (rangePicker.viewMonth < 0) { rangePicker.viewMonth = 11; rangePicker.viewYear--; }
  if (rangePicker.viewMonth > 11) { rangePicker.viewMonth = 0; rangePicker.viewYear++; }
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
    case "lastMonth":
      rangePicker.start = toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      rangePicker.end = toISODate(new Date(now.getFullYear(), now.getMonth(), 0));
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

// ===== v2 費率設定 =====
// 每個 rule 以精確 model 名稱比對（rule.model === record.model）。
// rates 陣列：每筆版本含生效時間範圍（from/to，null=無邊界）+ 計費模式。
//   Flat：pricing.flat（不分時段）
//   Time-based：windows.peak（peak 時段，off-peak 自動為補集）+ pricing.peak + pricing.offpeak
// 價格表可選 tier（依 input+cacheRead 總 context 分低/高兩級）。
// 費率為每百萬 token 的 USD 價格。
const RATES_VERSION = 2;
const RATES_KEY = "opencode_model_rates_v2";

const DEFAULT_MODEL_RATES = [
  // Free models - 無已知價格，維持 $0
  { id: "r1", label: "Big Pickle", model: "big-pickle", rates: [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
  { id: "r2", label: "Hy3 Free", model: "hy3-free", rates: [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
  { id: "r3", label: "Laguna S 2.1 Free", model: "laguna-s-2.1-free", rates: [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
  { id: "r4", label: "Ling 3.0 Tiny Free", model: "ling-3.0-tiny-free", rates: [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
  { id: "r5", label: "Nemotron 3 Ultra Free", model: "nemotron-3-ultra-free", rates: [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
  { id: "r6", label: "Nemotron 3.5 Lightning Free", model: "nemotron-3.5-lightning-free", rates: [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },

  // DeepSeek V4 Flash - 2026-08-16T16:00:00Z 起改為 peak/off-peak 計費
  {
    id: "r7",
    label: "DeepSeek V4 Flash",
    model: "deepseek-v4-flash",
    rates: [
      { from: null, to: "2026-08-16T16:00:00Z", pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        to: null,
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
  // DeepSeek V4 Flash Free - 同模型不同來源，費率重複填寫
  {
    id: "r7b",
    label: "DeepSeek V4 Flash (Free)",
    model: "deepseek-v4-flash-free",
    rates: [
      { from: null, to: "2026-08-16T16:00:00Z", pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        to: null,
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

  // DeepSeek V4 Pro - 2026-08-16T16:00:00Z 起改為 peak/off-peak 計費
  {
    id: "r18",
    label: "DeepSeek V4 Pro",
    model: "deepseek-v4-pro",
    rates: [
      { from: null, to: "2026-08-16T16:00:00Z", pricing: { flat: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        to: null,
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
  // DeepSeek V4 Pro Free - 同模型不同來源，費率重複填寫
  {
    id: "r18b",
    label: "DeepSeek V4 Pro (Free)",
    model: "deepseek-v4-pro-free",
    rates: [
      { from: null, to: "2026-08-16T16:00:00Z", pricing: { flat: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } } },
      {
        from: "2026-08-16T16:00:00Z",
        to: null,
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

  // 其餘模型 - 單筆 flat 版本，不分時段
  { id: "r8", label: "GLM 5.3", model: "glm-5.3", rates: [{ from: null, to: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }] },
  { id: "r8b", label: "GLM 5.2", model: "glm-5.2", rates: [{ from: null, to: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }] },
  { id: "r12", label: "GLM 5.1", model: "glm-5.1", rates: [{ from: null, to: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }] },
  { id: "r9", label: "Kimi K2.7 Code", model: "kimi-k2.7-code", rates: [{ from: null, to: null, pricing: { flat: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 } } }] },
  { id: "r10", label: "Kimi K2.6", model: "kimi-k2.6", rates: [{ from: null, to: null, pricing: { flat: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 } } }] },
  { id: "r13", label: "Kimi K3", model: "kimi-k3", rates: [{ from: null, to: null, pricing: { flat: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 } } }] },
  { id: "r11", label: "Grok 4.5", model: "grok-4.5", rates: [{ from: null, to: null, pricing: { flat: { input: 2.0, output: 6.0, cacheRead: 0.3, cacheWrite: 0 } } }] },
  { id: "r14", label: "MiMo V2.5 Pro", model: "mimo-v2.5-pro", rates: [{ from: null, to: null, pricing: { flat: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } } }] },
  { id: "r15", label: "MiMo V2.5", model: "mimo-v2.5", rates: [{ from: null, to: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } }] },
  { id: "r16", label: "MiniMax M3", model: "minimax-m3", rates: [{ from: null, to: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 } } }] },
  { id: "r17", label: "MiniMax M2.7", model: "minimax-m2.7", rates: [{ from: null, to: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 } } }] },
  { id: "r17b", label: "MiniMax M2.5", model: "minimax-m2.5", rates: [{ from: null, to: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 } } }] },
  { id: "r19", label: "Qwen 3.8 Max", model: "qwen-3.8-max", rates: [{ from: null, to: null, pricing: { flat: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 } } }] },
  { id: "r20", label: "Qwen 3.7 Max", model: "qwen-3.7-max", rates: [{ from: null, to: null, pricing: { flat: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 } } }] },
  {
    id: "r21",
    label: "Qwen 3.7 Plus",
    model: "qwen-3.7-plus",
    rates: [{ from: null, to: null, pricing: { flat: { tier: { limit: 256000, low: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 }, high: { input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 1.5 } } } } }],
  },
  {
    id: "r22",
    label: "Qwen 3.6 Plus",
    model: "qwen-3.6-plus",
    rates: [{ from: null, to: null, pricing: { flat: { tier: { limit: 256000, low: { input: 0.5, output: 3.0, cacheRead: 0.05, cacheWrite: 0.625 }, high: { input: 2.0, output: 6.0, cacheRead: 0.2, cacheWrite: 2.5 } } } } }],
  },
  {
    id: "r23",
    label: "GPT 5.6 Luna",
    model: "gpt-5.6-luna",
    rates: [{ from: null, to: null, pricing: { flat: { tier: { limit: 272000, low: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }, high: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 } } } } }],
  },
  { id: "r24", label: "Hy3", model: "hy3", rates: [{ from: null, to: null, pricing: { flat: { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 } } }] },
];

// 版本升級 = 直接覆蓋：儲存版本 ≠ 目前版本 → 使用新版內建預設值。
// 同一版本內使用者的編輯會保留（存回同 key）。
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
}

// ===== 模型比對與計算邏輯 =====
// 精確比對：rule.model === record.model，無關鍵字、無碰撞。
function matchRule(modelName, rules) {
  for (const rule of rules) {
    if (rule.model === modelName) return rule;
  }
  return null;
}

// 解析 from/to 邊界為 timestamp；null/空字串 → null（無邊界）。
function parseBound(bound) {
  if (bound == null || bound === "") return null;
  const t = new Date(bound).getTime();
  return isNaN(t) ? null : t;
}

// 依記錄時間選取費率版本；時間無法解析時用最新版本（to: null 或最後一筆）。
function getRateEntry(rule, recordTime) {
  const ts = new Date(recordTime).getTime();
  const validTs = isNaN(ts) ? null : ts;
  let fallback = null;
  for (const entry of rule.rates || []) {
    const fromTs = parseBound(entry.from);
    const toTs = parseBound(entry.to);
    if (validTs !== null) {
      if (fromTs !== null && validTs < fromTs) continue;
      if (toTs !== null && validTs > toTs) continue;
      return entry;
    }
    if (toTs === null) fallback = entry; // 無邊界版本作為 fallback
  }
  return fallback || (rule.rates && rule.rates[rule.rates.length - 1]) || null;
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 判定時段：無 windows → flat；落在任一 peak window → peak；否則 offpeak（補集）。
function getWindow(record, entry) {
  const peakWindows = entry.windows && entry.windows.peak;
  if (!peakWindows || peakWindows.length === 0) return "flat";
  const t = new Date(record.time);
  if (isNaN(t.getTime())) return "flat";
  const weekday = t.getUTCDay(); // 固定 UTC
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
      // 跨午夜：start 之後或 end 之前
      if (minutes >= start || minutes < end) return "peak";
    }
  }
  return "offpeak";
}

// 解析價格表：依 window 取表，缺漏時沿用另一時段（保守）；tier 依 input+cacheRead 總 context 分級。
function resolveTable(entry, window, inputTokens, cacheReadTokens) {
  const pricing = entry.pricing || {};
  let table = pricing[window];
  if (!table) table = window === "peak" ? pricing.offpeak : pricing.peak; // 缺漏時沿用另一時段
  if (!table) return null;
  if (table.tier) {
    const context = (inputTokens || 0) + (cacheReadTokens || 0);
    const tierTable = context <= table.tier.limit ? table.tier.low : table.tier.high;
    if (tierTable) return tierTable;
    // tier 不完整 → 退回表層費率
    if (table.input !== undefined || table.output !== undefined) return table;
    return null;
  }
  return table;
}

// 計算單筆 cost 與 savings。回傳 window 供拆分顯示，unpriced 標記未定價。
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

function renderDashboard() {
  const selectedWS = document.getElementById("workspaceSelect").value;
  const selectedModel = document.getElementById("modelSelect").value;
  const startDate = document.getElementById("startDate").value;
  let endDate = document.getElementById("endDate").value;
  if (startDate && !endDate) endDate = startDate; // Single-day selection counts as exactly that day.

  filteredRecordsCache = [];
  let totalReq = 0, totalCost = 0, totalSavings = 0, totalTokens = 0, totalPrompt = 0, totalCacheRead = 0;
  let totalPeakCost = 0, totalOffpeakCost = 0;
  const dailyMap = {}, dailyTokenMap = {}, modelMap = {}, wsMap = {}, singleModelDailyMap = {};
  const unpricedModels = new Set();
  const rates = getRates(); // Hoisted: one read instead of one per record.
  const splitEnabled = document.getElementById("splitToggle").checked;

  for (const [id, rec] of Object.entries(globalCache)) {
    const wsID = rec.workspaceID || "wrk_unknown";
    const modelName = rec.model || "Unknown";
    const recDate = rec.date || "";

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

    const date = rec.date || "Unknown";
    dailyMap[date] = (dailyMap[date] || 0) + cost;
    dailyTokenMap[date] = (dailyTokenMap[date] || 0) + tokens;

    if (!singleModelDailyMap[date]) {
      singleModelDailyMap[date] = { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    }
    singleModelDailyMap[date].req++;
    singleModelDailyMap[date].input += (rec.input || 0);
    singleModelDailyMap[date].output += (rec.output || 0);
    singleModelDailyMap[date].cacheRead += (rec.cacheRead || 0);
    singleModelDailyMap[date].cost += cost;

    if (!modelMap[modelName]) {
      modelMap[modelName] = { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, peakCost: 0, offpeakCost: 0 };
    }
    modelMap[modelName].req++;
    modelMap[modelName].input += (rec.input || 0);
    modelMap[modelName].output += (rec.output || 0);
    modelMap[modelName].cacheRead += (rec.cacheRead || 0);
    modelMap[modelName].cost += cost;
    if (window === "peak") modelMap[modelName].peakCost += cost;
    else if (window === "offpeak") modelMap[modelName].offpeakCost += cost;
  }

  document.getElementById("statRequests").innerText = totalReq.toLocaleString();
  document.getElementById("statCost").innerText = `$${fmtMoney(totalCost)}`;
  document.getElementById("statSavings").innerText = `Cache savings: $${fmtMoney(totalSavings)}`;
  document.getElementById("statTokens").innerText = totalTokens.toLocaleString();
  document.getElementById("statHitRate").innerText = totalPrompt > 0 ? `${((totalCacheRead / totalPrompt) * 100).toFixed(2)}%` : "0.00%";
  document.getElementById("statAvgCostPerReq").innerText = `Avg per request: $${totalReq > 0 ? fmtMoney(totalCost / totalReq, 5) : "0.00000"}`;
  document.getElementById("statAvgTokens").innerText = `Avg tokens/request: ${totalReq > 0 ? Math.round(totalTokens / totalReq).toLocaleString() : 0}`;
  const statSplit = document.getElementById("statSplit");
  if (statSplit) {
    statSplit.innerText = splitEnabled
      ? `Peak: $${fmtMoney(totalPeakCost)} · Off-peak: $${fmtMoney(totalOffpeakCost)}`
      : "";
  }

  // 未定價 / 不完整模型清單
  const unpricedEl = document.getElementById("unpricedList");
  if (unpricedEl) {
    if (unpricedModels.size > 0) {
      unpricedEl.hidden = false;
      unpricedEl.innerHTML =
        `<strong>未定價模型（${unpricedModels.size}）</strong>：` +
        Array.from(unpricedModels).sort().map((m) => `<span class="badge">${escHTML(m)}</span>`).join(" ") +
        ` <span style="opacity:.75">— 在 Rate Settings 新增對應 rule 即可計價。</span>`;
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
        ${splitEnabled ? `<th data-col="peakCost">Peak Cost</th><th data-col="offpeakCost">Off-peak Cost</th>` : ""}
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
        ${splitEnabled ? `<td>$${fmtMoney(stats.peakCost)}</td><td>$${fmtMoney(stats.offpeakCost)}</td>` : ""}
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

  // Draw charts.
  const dates = Object.keys(dailyMap).sort();
  const dailyCosts = dates.map((d) => dailyMap[d]);
  const dailyTokens = dates.map((d) => dailyTokenMap[d]);

  if (dailyChartInst) dailyChartInst.destroy();
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
      scales: {
        x: axis(),
        yCost: axis({ type: "linear", position: "left" }),
        yToken: axis({ type: "linear", position: "right", grid: { drawOnChartArea: false } })
      }
    })
  });

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

  const wsLabels = Object.keys(wsMap);
  const wsCosts = wsLabels.map((w) => wsMap[w].cost);
  if (workspaceChartInst) workspaceChartInst.destroy();
  workspaceChartInst = new Chart(document.getElementById("workspaceChart"), {
    type: "bar",
    data: {
      labels: wsLabels,
      datasets: [{ label: "Estimated Cost (USD)", data: wsCosts, backgroundColor: CHART_COLORS.blue }]
    },
    options: chartOptions({
      indexAxis: "y",
      scales: {
        x: axis(),
        y: axis()
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
      rec.date || "",
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

// Number field with custom − / + steppers (rates default to 0.1 steps).
const numField = (cls, label, value, step = "0.1") =>
  `<label>${label} <span class="num-field">` +
  `<button type="button" class="num-btn" data-dir="down" aria-label="Decrease">&minus;</button>` +
  `<input class="${cls}" type="number" step="${step}" value="${value}">` +
  `<button type="button" class="num-btn" data-dir="up" aria-label="Increase">+</button></span></label>`;

// 價格表（可選 tier：依 input+cacheRead 總 context 分低/高兩級）
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

// Peak 時段列（off-peak 自動為補集，不需填）
function windowRowHTML(w) {
  const days = w && w.days ? w.days.join(",") : "";
  return `
    <div class="rv-window">
      <input class="rv-window-days" value="${escAttr(days)}" placeholder="Days 0-6">
      <input class="rv-window-start" value="${escAttr((w && w.start) || "")}" placeholder="Start HH:MM">
      <input class="rv-window-end" value="${escAttr((w && w.end) || "")}" placeholder="End HH:MM">
      <button type="button" class="rv-window-del" aria-label="Remove window">&times;</button>
    </div>`;
}

// 單筆費率版本
// 每個版本用唯一 uid 產生 class 前綴（data-prefix），避免刪除版本後索引錯位。
let versionUid = 0;
function rateVersionHTML(entry, idx) {
  const mode = entry.windows && entry.windows.peak && entry.windows.peak.length > 0 ? "time" : "flat";
  const windows = (entry.windows && entry.windows.peak) || [];
  const uid = "rv" + (++versionUid);
  return `
    <div class="rate-version" data-mode="${mode}" data-prefix="${uid}">
      <div class="rv-head">
        <span class="rv-title">Version ${idx + 1}</span>
        <button type="button" class="rv-del">Del</button>
      </div>
      <div class="rv-dates">
        <label>From <input class="rv-from" value="${escAttr(entry.from || "")}" placeholder="2026-08-16T16:00:00Z"></label>
        <label>To <input class="rv-to" value="${escAttr(entry.to || "")}" placeholder="(empty = no end)"></label>
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
          <div class="rv-windows-title">Peak Windows（off-peak = 其餘時間）</div>
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

// 單條 rule（精確 model 名稱 + 費率版本列表）
function rateRowHTML(rule) {
  const rates = rule.rates && rule.rates.length > 0 ? rule.rates : [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }];
  return `
    <div class="rate-row">
      <div class="rate-main">
        <input class="rate-model" value="${escAttr(rule.model || "")}" placeholder="Model name (exact)">
        <input class="rate-label" value="${escAttr(rule.label || "")}" placeholder="Label">
        <button class="rate-del">Del</button>
      </div>
      <div class="rate-versions">
        ${rates.map((e, i) => rateVersionHTML(e, i)).join("")}
      </div>
      <button type="button" class="rv-add-version">+ Add Rate Version</button>
    </div>`;
}

function wireSteppers(scope) {
  scope.querySelectorAll(".num-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.closest(".num-field").querySelector("input");
      const step = parseFloat(input.step) || 1;
      const val = parseFloat(input.value) || 0;
      const delta = btn.dataset.dir === "down" ? -step : step;
      // Round to 4 decimals to avoid float artifacts (e.g. 0.1 + 0.2).
      input.value = Math.round((val + delta) * 10000) / 10000;
    });
  });
}

// 模式切換：flat / time-based
function wireModeSelect(select) {
  select.addEventListener("change", () => {
    const version = select.closest(".rate-version");
    const mode = select.value;
    version.dataset.mode = mode;
    version.querySelector(".rv-flat-section").hidden = mode !== "flat";
    version.querySelector(".rv-time-section").hidden = mode !== "time";
  });
}

// tier 開關：勾選顯示 low/high，取消顯示單一價格
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
    versions.insertAdjacentHTML("beforeend", rateVersionHTML({ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, versions.children.length));
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
  wireSteppers(version);
}

function renderRateList() {
  const list = document.getElementById("ratesList");
  list.innerHTML = getRates().map((r) => rateRowHTML(r)).join("");
  list.querySelectorAll(".rate-del").forEach(wireDelete);
  list.querySelectorAll(".rv-add-version").forEach(wireVersionAdd);
  list.querySelectorAll(".rate-version").forEach(wireVersionControls);
}

// 從 DOM 收集費率設定（含結構驗證）
function collectRates() {
  const rules = [];
  document.querySelectorAll("#ratesList .rate-row").forEach((row, idx) => {
    const model = row.querySelector(".rate-model").value.trim();
    const label = row.querySelector(".rate-label").value.trim();
    // 保留空 model 的 rule，讓 validateRates 攔截並提示（不靜默丟棄）
    const num = (el) => parseFloat(el.value) || 0;
    const rates = [];
    row.querySelectorAll(".rate-version").forEach((version) => {
      const mode = version.dataset.mode || "flat";
      const prefix = version.dataset.prefix || "rv0"; // 唯一前綴，避免刪除版本後索引錯位
      const from = version.querySelector(".rv-from").value.trim() || null;
      const to = version.querySelector(".rv-to").value.trim() || null;
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
      const entry = { from, to };
      if (mode === "time") {
        const windows = [];
        version.querySelectorAll(".rv-window").forEach((w) => {
          const days = w.querySelector(".rv-window-days").value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).map(Number);
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
    rules.push({ id: `r${Date.now()}_${idx}`, label, model, rates });
  });
  return rules;
}

// 結構驗證：model 必填、至少一筆版本、版本範圍不重疊、價格表完整
function validateRates(models) {
  const errors = [];
  for (const rule of models) {
    if (!rule.model) { errors.push("有 rule 缺少 model 名稱"); continue; }
    if (!rule.rates || rule.rates.length === 0) { errors.push(`${rule.model} 至少需要一筆費率版本`); continue; }
    const ranges = rule.rates.map((e) => [parseBound(e.from), parseBound(e.to)]);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const aStart = ranges[i][0] === null ? -Infinity : ranges[i][0];
        const aEnd = ranges[i][1] === null ? Infinity : ranges[i][1];
        const bStart = ranges[j][0] === null ? -Infinity : ranges[j][0];
        const bEnd = ranges[j][1] === null ? Infinity : ranges[j][1];
        if (aStart <= bEnd && bStart <= aEnd) {
          errors.push(`${rule.model} 的費率版本 ${i + 1} 與 ${j + 1} 時間範圍重疊`);
        }
      }
    }
    for (const entry of rule.rates) {
      const pricing = entry.pricing || {};
      const mode = entry.windows && entry.windows.peak && entry.windows.peak.length > 0 ? "time" : "flat";
      if (mode === "flat") {
        if (!pricing.flat) errors.push(`${rule.model} 版本缺 flat 價格表`);
      } else {
        if (!pricing.peak || !pricing.offpeak) errors.push(`${rule.model} 版本缺 peak/offpeak 價格表`);
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
  document.getElementById("ratesModal").style.display = "none";
}

// ===== JSON 匯入 / 匯出 =====
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
        alert("匯入的設定有問題：\n" + errors.join("\n"));
        return;
      }
      saveRates(models);
      renderRateList();
      renderDashboard();
      alert(`已匯入 ${models.length} 條 rule`);
    } catch (e) {
      alert("匯入失敗：不是有效的 JSON 設定");
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
  renderDashboard();
});
document.getElementById("btnRates").addEventListener("click", openRatesModal);
document.getElementById("ratesClose").addEventListener("click", closeRatesModal);
document.getElementById("ratesModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeRatesModal();
});
document.getElementById("ratesAdd").addEventListener("click", () => {
  const list = document.getElementById("ratesList");
  list.insertAdjacentHTML("beforeend", rateRowHTML({ label: "", model: "", rates: [{ from: null, to: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] }));
  const row = list.lastElementChild;
  wireDelete(row.querySelector(".rate-del"));
  wireVersionAdd(row.querySelector(".rv-add-version"));
  wireVersionControls(row.querySelector(".rate-version"));
});
document.getElementById("ratesSave").addEventListener("click", () => {
  const models = collectRates();
  const errors = validateRates(models);
  if (errors.length > 0) {
    alert("無法儲存：\n" + errors.join("\n"));
    return;
  }
  saveRates(models);
  closeRatesModal();
  renderDashboard();
});
document.getElementById("ratesReset").addEventListener("click", () => {
  localStorage.removeItem(RATES_KEY);
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
document.getElementById("splitToggle").addEventListener("change", renderDashboard);
document.getElementById("workspaceSelect").addEventListener("change", renderDashboard);
document.getElementById("modelSelect").addEventListener("change", renderDashboard);

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

loadFromExtension();
