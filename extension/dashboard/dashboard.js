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

// Model rate rules. A rule matches when the (lowercased) model name includes ALL of its
// keywords; the first matching rule wins. Rates are USD per million tokens. Rules with a
// `tier` apply different rates above/below a token threshold.
const DEFAULT_MODEL_RATES = [
  // Free models with no paid counterpart - no known price yet, keep at $0
  // (edit via Rate Settings once priced). Free variants that map to a paid
  // model (e.g. deepseek-v4-flash-free) are priced by that rule below.
  { id: "r1", label: "Big Pickle", keywords: ["big", "pickle"], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { id: "r2", label: "Hy3 Free", keywords: ["hy3", "free"], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { id: "r3", label: "Laguna S 2.1 Free", keywords: ["laguna", "free"], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { id: "r4", label: "Ling 3.0 Tiny Free", keywords: ["ling", "tiny", "free"], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { id: "r5", label: "Nemotron 3 Ultra Free", keywords: ["nemotron", "ultra", "free"], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { id: "r6", label: "Nemotron 3.5 Lightning Free", keywords: ["nemotron", "lightning", "free"], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { id: "r7", label: "DeepSeek V4 Flash", keywords: ["deepseek", "flash"], input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  { id: "r8", label: "GLM 5.2", keywords: ["glm", "5.2"], input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  { id: "r9", label: "Kimi K2.7 Code", keywords: ["kimi", "k2.7", "code"], input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
  { id: "r10", label: "Kimi K2.6", keywords: ["kimi", "k2.6"], input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
  { id: "r11", label: "Grok 4.5", keywords: ["grok", "4.5"], input: 2.0, output: 6.0, cacheRead: 0.5, cacheWrite: 0 },
  { id: "r12", label: "GLM 5.1", keywords: ["glm", "5.1"], input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  { id: "r13", label: "Kimi K3", keywords: ["kimi", "k3"], input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
  { id: "r14", label: "Mimo V2.5 Pro", keywords: ["mimo", "v2.5", "pro"], input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  { id: "r15", label: "Mimo V2.5", keywords: ["mimo", "v2.5"], input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  { id: "r16", label: "MiniMax M3", keywords: ["minimax", "m3"], input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  { id: "r17", label: "MiniMax M2.7", keywords: ["minimax", "m2.7"], input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  { id: "r18", label: "DeepSeek V4 Pro", keywords: ["deepseek", "v4", "pro"], input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  { id: "r19", label: "Qwen 3.8 Max", keywords: ["3.8", "max"], input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 },
  { id: "r20", label: "Qwen 3.7 Max", keywords: ["qwen", "3.7", "max"], input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
  {
    id: "r21",
    label: "Qwen 3.7 Plus",
    keywords: ["qwen", "3.7", "plus"],
    tier: {
      limit: 256000,
      low: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
      high: { input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 1.5 },
    },
  },
  {
    id: "r22",
    label: "Qwen 3.6 Plus",
    keywords: ["qwen", "3.6", "plus"],
    tier: {
      limit: 256000,
      low: { input: 0.5, output: 3.0, cacheRead: 0.05, cacheWrite: 0.625 },
      high: { input: 2.0, output: 6.0, cacheRead: 0.2, cacheWrite: 2.5 },
    },
  },
  { id: "r23", label: "GPT 5.6 Luna", keywords: ["5.6", "luna"], input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  { id: "r24", label: "Hy3", keywords: ["hy3"], input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
];

const RATES_KEY = "opencode_model_rates_v1";

// User-edited rates take priority; fall back to the built-in defaults.
function getRates() {
  try {
    const raw = localStorage.getItem(RATES_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch (e) {}
  return DEFAULT_MODEL_RATES;
}

function saveRates(rates) {
  localStorage.setItem(RATES_KEY, JSON.stringify(rates));
}

// `rates` is passed in by renderDashboard to avoid re-reading + parsing
// localStorage for every record on every render.
function getRecordCostAndSavings(record, rates = getRates()) {
  const modelName = (record.model || "").toLowerCase();
  for (const rule of rates) {
    const kws = rule.keywords || [];
    if (kws.length === 0) continue;
    if (!kws.every((k) => modelName.includes(String(k).toLowerCase()))) continue;

    let r = rule;
    if (rule.tier) {
      r = (record.input || 0) <= rule.tier.limit ? rule.tier.low : rule.tier.high;
    }
    const inputRate = r.input || 0;
    const outputRate = r.output || 0;
    const cacheReadRate = r.cacheRead || 0;
    const cacheWriteRate = r.cacheWrite || 0;
    const cacheWriteTokens = (record.cacheWrite5m || 0) + (record.cacheWrite1h || 0);
    const cost = ((record.input || 0) * inputRate + (record.cacheRead || 0) * cacheReadRate + cacheWriteTokens * cacheWriteRate + (record.output || 0) * outputRate) / 1000000;
    const savings = (record.cacheRead || 0) * (inputRate - cacheReadRate) / 1000000;
    return { cost, savings };
  }
  return { cost: 0, savings: 0 };
}

function renderDashboard() {
  const selectedWS = document.getElementById("workspaceSelect").value;
  const selectedModel = document.getElementById("modelSelect").value;
  const startDate = document.getElementById("startDate").value;
  let endDate = document.getElementById("endDate").value;
  if (startDate && !endDate) endDate = startDate; // Single-day selection counts as exactly that day.

  filteredRecordsCache = [];
  let totalReq = 0, totalCost = 0, totalSavings = 0, totalTokens = 0, totalPrompt = 0, totalCacheRead = 0;
  const dailyMap = {}, dailyTokenMap = {}, modelMap = {}, wsMap = {}, singleModelDailyMap = {};
  const rates = getRates(); // Hoisted: one read instead of one per record.

  for (const [id, rec] of Object.entries(globalCache)) {
    const wsID = rec.workspaceID || "wrk_unknown";
    const modelName = rec.model || "Unknown";
    const recDate = rec.date || "";

    if (startDate && recDate && recDate < startDate) continue;
    if (endDate && recDate && recDate > endDate) continue;

    if (!wsMap[wsID]) {
      wsMap[wsID] = { req: 0, tokens: 0, prompt: 0, cacheRead: 0, cost: 0 };
    }
    const { cost, savings } = getRecordCostAndSavings(rec, rates);
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

    filteredRecordsCache.push({ id, ...rec, cost, savings, tokens });

    totalReq++;
    totalCost += cost;
    totalSavings += savings;
    totalTokens += tokens;
    totalPrompt += promptTokens;
    totalCacheRead += (rec.cacheRead || 0);

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
      modelMap[modelName] = { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    }
    modelMap[modelName].req++;
    modelMap[modelName].input += (rec.input || 0);
    modelMap[modelName].output += (rec.output || 0);
    modelMap[modelName].cacheRead += (rec.cacheRead || 0);
    modelMap[modelName].cost += cost;
  }

  document.getElementById("statRequests").innerText = totalReq.toLocaleString();
  document.getElementById("statCost").innerText = `$${fmtMoney(totalCost)}`;
  document.getElementById("statSavings").innerText = `Cache savings: $${fmtMoney(totalSavings)}`;
  document.getElementById("statTokens").innerText = totalTokens.toLocaleString();
  document.getElementById("statHitRate").innerText = totalPrompt > 0 ? `${((totalCacheRead / totalPrompt) * 100).toFixed(2)}%` : "0.00%";
  document.getElementById("statAvgCostPerReq").innerText = `Avg per request: $${totalReq > 0 ? fmtMoney(totalCost / totalReq, 5) : "0.00000"}`;
  document.getElementById("statAvgTokens").innerText = `Avg tokens/request: ${totalReq > 0 ? Math.round(totalTokens / totalReq).toLocaleString() : 0}`;

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
  const headers = ["ID", "WorkspaceID", "Date", "Model", "Input", "Output", "Reasoning", "CacheRead", "CacheWrite5m", "CacheWrite1h", "SavingsUSD", "CostUSD"];
  const rows = [headers.join(",")];

  for (const rec of filteredRecordsCache) {
    const row = [
      rec.id,
      rec.workspaceID || "",
      rec.date || "",
      rec.model || "",
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
function rateRowHTML(rule) {
  const esc = (v) => String(v ?? "").replace(/"/g, "&quot;");
  const kw = (rule.keywords || []).join(",");
  // Number field with custom − / + steppers (rates default to 0.1 steps).
  const num = (cls, label, value, step = "0.1") =>
    `<label>${label} <span class="num-field">` +
    `<button type="button" class="num-btn" data-dir="down" aria-label="Decrease">&minus;</button>` +
    `<input class="${cls}" type="number" step="${step}" value="${value}">` +
    `<button type="button" class="num-btn" data-dir="up" aria-label="Increase">+</button></span></label>`;
  if (rule.tier) {
    const t = rule.tier;
    const low = t.low || {};
    const high = t.high || {};
    // One rate-group per line: fixed title column + fields (Low / High each on its own row).
    const group = (title, inner) =>
      `<div class="rate-group"><span class="rate-group-title">${title}</span>${inner}</div>`;
    return `
      <div class="rate-row" data-tier="1">
        <div class="rate-main">
          <input class="rate-label" value="${esc(rule.label || "")}" placeholder="Name">
          <input class="rate-kw" value="${esc(kw)}" placeholder="Keywords (comma separated)">
        </div>
        <div class="rate-fields tier-fields">
          ${group("Tier", num("tier-limit", "&le;Limit", t.limit ?? 0, "1"))}
          ${group("Low",
            num("tier-low-input", "In", low.input ?? 0) +
            num("tier-low-output", "Out", low.output ?? 0) +
            num("tier-low-cr", "CR", low.cacheRead ?? 0) +
            num("tier-low-cw", "CW", low.cacheWrite ?? 0))}
          ${group("High",
            num("tier-high-input", "In", high.input ?? 0) +
            num("tier-high-output", "Out", high.output ?? 0) +
            num("tier-high-cr", "CR", high.cacheRead ?? 0) +
            num("tier-high-cw", "CW", high.cacheWrite ?? 0) +
            `<button class="rate-del">Del</button>`)}
        </div>
      </div>`;
  }
  return `
    <div class="rate-row">
      <div class="rate-main">
        <input class="rate-label" value="${esc(rule.label || "")}" placeholder="Name">
        <input class="rate-kw" value="${esc(kw)}" placeholder="Keywords (comma separated)">
      </div>
      <div class="rate-fields">
        ${num("rate-input", "Input", rule.input ?? 0)}
        ${num("rate-output", "Output", rule.output ?? 0)}
        ${num("rate-cr", "CacheRead", rule.cacheRead ?? 0)}
        ${num("rate-cw", "CacheWrite", rule.cacheWrite ?? 0)}
        <button class="rate-del">Del</button>
      </div>
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

function wireDelete(btn) {
  btn.addEventListener("click", () => btn.closest(".rate-row").remove());
}

function renderRateList() {
  const list = document.getElementById("ratesList");
  list.innerHTML = getRates().map((r) => rateRowHTML(r)).join("");
  list.querySelectorAll(".rate-del").forEach(wireDelete);
  wireSteppers(list);
}

function collectRates() {
  const rules = [];
  document.querySelectorAll("#ratesList .rate-row").forEach((row, idx) => {
    const label = row.querySelector(".rate-label").value.trim();
    const kw = row.querySelector(".rate-kw").value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (kw.length === 0) return;
    const num = (el) => parseFloat(el.value) || 0;
    const id = `r${Date.now()}_${idx}`;
    if (row.dataset.tier === "1") {
      rules.push({
        id,
        label,
        keywords: kw,
        tier: {
          limit: num(row.querySelector(".tier-limit")),
          low: { input: num(row.querySelector(".tier-low-input")), output: num(row.querySelector(".tier-low-output")), cacheRead: num(row.querySelector(".tier-low-cr")), cacheWrite: num(row.querySelector(".tier-low-cw")) },
          high: { input: num(row.querySelector(".tier-high-input")), output: num(row.querySelector(".tier-high-output")), cacheRead: num(row.querySelector(".tier-high-cr")), cacheWrite: num(row.querySelector(".tier-high-cw")) },
        },
      });
    } else {
      rules.push({
        id,
        label,
        keywords: kw,
        input: num(row.querySelector(".rate-input")),
        output: num(row.querySelector(".rate-output")),
        cacheRead: num(row.querySelector(".rate-cr")),
        cacheWrite: num(row.querySelector(".rate-cw")),
      });
    }
  });
  return rules;
}

function openRatesModal() {
  renderRateList();
  document.getElementById("ratesModal").style.display = "flex";
}

function closeRatesModal() {
  document.getElementById("ratesModal").style.display = "none";
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
  list.insertAdjacentHTML("beforeend", rateRowHTML({ label: "", keywords: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
  const row = list.lastElementChild;
  wireDelete(row.querySelector(".rate-del"));
  wireSteppers(row);
});
document.getElementById("ratesSave").addEventListener("click", () => {
  saveRates(collectRates());
  closeRatesModal();
  renderDashboard();
});
document.getElementById("ratesReset").addEventListener("click", () => {
  localStorage.removeItem(RATES_KEY);
  renderRateList();
});
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
