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

function markSortHeader(tableId, col, dir) {
  document.querySelectorAll(`#${tableId} th[data-col]`).forEach((th) => {
    if (th.dataset.base === undefined) th.dataset.base = th.textContent;
    th.textContent = th.dataset.col === col ? th.dataset.base + (dir === -1 ? " ▼" : " ▲") : th.dataset.base;
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
  }
}

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

function getRecordCostAndSavings(record) {
  const modelName = (record.model || "").toLowerCase();
  for (const rule of getRates()) {
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
  const endDate = document.getElementById("endDate").value;
  const searchKeyword = document.getElementById("searchInput").value.trim().toLowerCase();

  filteredRecordsCache = [];
  let totalReq = 0, totalCost = 0, totalSavings = 0, totalTokens = 0, totalPrompt = 0, totalCacheRead = 0;
  const dailyMap = {}, dailyTokenMap = {}, modelMap = {}, wsMap = {}, singleModelDailyMap = {};

  for (const [id, rec] of Object.entries(globalCache)) {
    const wsID = rec.workspaceID || "wrk_unknown";
    const modelName = rec.model || "Unknown";
    const recDate = rec.date || "";

    if (searchKeyword && !id.toLowerCase().includes(searchKeyword)) continue;
    if (startDate && recDate && recDate < startDate) continue;
    if (endDate && recDate && recDate > endDate) continue;

    if (!wsMap[wsID]) {
      wsMap[wsID] = { req: 0, tokens: 0, prompt: 0, cacheRead: 0, cost: 0 };
    }
    const { cost, savings } = getRecordCostAndSavings(rec);
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
  document.getElementById("statCost").innerText = `$${totalCost.toFixed(4)}`;
  document.getElementById("statSavings").innerText = `Cache savings: $${totalSavings.toFixed(4)}`;
  document.getElementById("statTokens").innerText = totalTokens.toLocaleString();
  document.getElementById("statHitRate").innerText = totalPrompt > 0 ? `${((totalCacheRead / totalPrompt) * 100).toFixed(2)}%` : "0.00%";
  document.getElementById("statAvgCostPerReq").innerText = `Avg per request: $${totalReq > 0 ? (totalCost / totalReq).toFixed(5) : "0.0000"}`;
  document.getElementById("statAvgTokens").innerText = `Avg tokens/request: ${totalReq > 0 ? Math.round(totalTokens / totalReq).toLocaleString() : 0}`;

  let topModel = "-", maxModelCost = 0;
  for (const [m, stats] of Object.entries(modelMap)) {
    if (stats.cost > maxModelCost) {
      maxModelCost = stats.cost;
      topModel = m;
    }
  }
  document.getElementById("statTopModel").innerText = topModel;
  document.getElementById("statTopModelCost").innerText = `Cost: $${maxModelCost.toFixed(4)}`;

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
      <td><span class="badge">${stats.ws}</span></td>
      <td>${stats.req}</td>
      <td>${stats.tokens.toLocaleString()}</td>
      <td>${hitRate}</td>
      <td><strong>$${stats.cost.toFixed(4)}</strong></td>
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
        <td><strong>${stats.model}</strong></td>
        <td>${stats.req}</td>
        <td>${stats.input.toLocaleString()}</td>
        <td>${stats.output.toLocaleString()}</td>
        <td>${stats.cacheRead.toLocaleString()}</td>
        <td>${stats.hitRate.toFixed(2)}%</td>
        <td>$${stats.cost.toFixed(4)}</td>
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
        <td><strong>${stats.date}</strong></td>
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
        { label: "Daily Cost (USD)", data: dailyCosts, borderColor: "#38bdf8", backgroundColor: "rgba(56, 189, 248, 0.1)", yAxisID: "yCost", fill: true, tension: 0.3 },
        { label: "Token Volume", data: dailyTokens, borderColor: "#c084fc", yAxisID: "yToken", borderDash: [5, 5], tension: 0.3 }
      ]
    },
    options: {
      plugins: { legend: { labels: { color: "#f8fafc", font: { family: "monospace" } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { family: "monospace" } } },
        yCost: { type: "linear", position: "left", ticks: { color: "#38bdf8", font: { family: "monospace" } } },
        yToken: { type: "linear", position: "right", grid: { drawOnChartArea: false }, ticks: { color: "#c084fc", font: { family: "monospace" } } }
      }
    }
  });

  const models = Object.keys(modelMap);
  const modelCosts = models.map((m) => modelMap[m].cost);
  if (modelChartInst) modelChartInst.destroy();
  modelChartInst = new Chart(document.getElementById("modelChart"), {
    type: "doughnut",
    data: {
      labels: models,
      datasets: [{ data: modelCosts, backgroundColor: ["#38bdf8", "#4ade80", "#c084fc", "#facc15", "#f87171", "#a78bfa"] }]
    },
    options: { plugins: { legend: { labels: { color: "#f8fafc", font: { family: "monospace" } } } } }
  });

  const inputs = models.map((m) => modelMap[m].input);
  const cacheReads = models.map((m) => modelMap[m].cacheRead);
  if (tokenTypeChartInst) tokenTypeChartInst.destroy();
  tokenTypeChartInst = new Chart(document.getElementById("tokenTypeChart"), {
    type: "bar",
    data: {
      labels: models,
      datasets: [
        { label: "Real Input Tokens", data: inputs, backgroundColor: "#38bdf8" },
        { label: "Cache Read Tokens", data: cacheReads, backgroundColor: "#4ade80" }
      ]
    },
    options: {
      plugins: { legend: { labels: { color: "#f8fafc", font: { family: "monospace" } } } },
      scales: {
        x: { stacked: true, ticks: { color: "#94a3b8", font: { family: "monospace" } } },
        y: { stacked: true, ticks: { color: "#94a3b8", font: { family: "monospace" } } }
      }
    }
  });

  const wsLabels = Object.keys(wsMap);
  const wsCosts = wsLabels.map((w) => wsMap[w].cost);
  if (workspaceChartInst) workspaceChartInst.destroy();
  workspaceChartInst = new Chart(document.getElementById("workspaceChart"), {
    type: "bar",
    data: {
      labels: wsLabels,
      datasets: [{ label: "Estimated Cost (USD)", data: wsCosts, backgroundColor: "#c084fc" }]
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { labels: { color: "#f8fafc", font: { family: "monospace" } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { family: "monospace" } } },
        y: { ticks: { color: "#94a3b8", font: { family: "monospace" } } }
      }
    }
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
      datasets: [{ label: "Cache Hit Rate (%)", data: hitRates, backgroundColor: "#facc15" }]
    },
    options: {
      plugins: { legend: { labels: { color: "#f8fafc", font: { family: "monospace" } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { family: "monospace" } } },
        y: { max: 100, ticks: { color: "#facc15", font: { family: "monospace" }, callback: (v) => v + "%" } }
      }
    }
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
async function loadFromExtension() {
  try {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    const { dashboardData } = await chrome.storage.local.get("dashboardData");
    if (!dashboardData) return;

    const data = JSON.parse(dashboardData);
    for (const [id, rec] of Object.entries(data)) {
      globalCache[id] = rec;
    }
    await chrome.storage.local.remove("dashboardData");
    initDateRange();
    updateDropdowns();
    renderDashboard();

    const container = document.querySelector(".container");
    if (container) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.innerHTML =
        `Auto-loaded <strong style="color:var(--accent-green)">` +
        `${Object.keys(data).length.toLocaleString()} records</strong> from the extension.`;
      container.prepend(notice);
    }
  } catch (e) {
    console.error("Failed to load extension data", e);
  }
}

// ===== Rate settings modal =====
function rateRowHTML(rule) {
  const esc = (v) => String(v ?? "").replace(/"/g, "&quot;");
  const kw = (rule.keywords || []).join(",");
  if (rule.tier) {
    const t = rule.tier;
    const low = t.low || {};
    const high = t.high || {};
    return `
      <div class="rate-row" data-tier="1">
        <div class="rate-main">
          <input class="rate-label" value="${esc(rule.label || "")}" placeholder="Name">
          <input class="rate-kw" value="${esc(kw)}" placeholder="Keywords (comma separated)">
        </div>
        <div class="rate-fields">
          <label>&le;Limit <input class="tier-limit" type="number" step="any" value="${t.limit ?? 0}"></label>
          <label>Low In <input class="tier-low-input" type="number" step="any" value="${low.input ?? 0}"></label>
          <label>Low Out <input class="tier-low-output" type="number" step="any" value="${low.output ?? 0}"></label>
          <label>Low CR <input class="tier-low-cr" type="number" step="any" value="${low.cacheRead ?? 0}"></label>
          <label>Low CW <input class="tier-low-cw" type="number" step="any" value="${low.cacheWrite ?? 0}"></label>
          <label>High In <input class="tier-high-input" type="number" step="any" value="${high.input ?? 0}"></label>
          <label>High Out <input class="tier-high-output" type="number" step="any" value="${high.output ?? 0}"></label>
          <label>High CR <input class="tier-high-cr" type="number" step="any" value="${high.cacheRead ?? 0}"></label>
          <label>High CW <input class="tier-high-cw" type="number" step="any" value="${high.cacheWrite ?? 0}"></label>
          <button class="rate-del">Del</button>
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
        <label>Input <input class="rate-input" type="number" step="any" value="${rule.input ?? 0}"></label>
        <label>Output <input class="rate-output" type="number" step="any" value="${rule.output ?? 0}"></label>
        <label>CacheRead <input class="rate-cr" type="number" step="any" value="${rule.cacheRead ?? 0}"></label>
        <label>CacheWrite <input class="rate-cw" type="number" step="any" value="${rule.cacheWrite ?? 0}"></label>
        <button class="rate-del">Del</button>
      </div>
    </div>`;
}

function wireDelete(btn) {
  btn.addEventListener("click", () => btn.closest(".rate-row").remove());
}

function renderRateList() {
  const list = document.getElementById("ratesList");
  list.innerHTML = getRates().map((r) => rateRowHTML(r)).join("");
  list.querySelectorAll(".rate-del").forEach(wireDelete);
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
  wireDelete(list.lastElementChild.querySelector(".rate-del"));
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
document.getElementById("startDate").addEventListener("change", renderDashboard);
document.getElementById("endDate").addEventListener("change", renderDashboard);
document.getElementById("searchInput").addEventListener("input", renderDashboard);

loadFromExtension();
