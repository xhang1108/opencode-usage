// extension/dashboard/views/tables.js
// Workspace + model detail tables, sortable headers and sort wiring.

import { sortBy } from "../core/sort.js";
import { fmtMoney, escHTML } from "./format.js";
import { workspaceRows, modelRows, dailyRows } from "./table-model.js";

export function markSortHeader(tableId, col, dir) {
  document.querySelectorAll(`#${tableId} th[data-col]`).forEach((th) => {
    if (th.dataset.base === undefined) th.dataset.base = th.textContent;
    const isSorted = th.dataset.col === col;
    th.textContent = isSorted ? th.dataset.base + (dir === -1 ? " ▼" : " ▲") : th.dataset.base;
    th.classList.toggle("th-sorted", isSorted);
  });
}

export function renderWorkspaceTable(wsMap, sortState, labelFor) {
  const wsTbody = document.getElementById("wsTableBody");
  wsTbody.innerHTML = "";
  const wsRows = workspaceRows(wsMap);
  for (const stats of sortBy(wsRows, sortState.col, sortState.dir)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="badge">${escHTML(labelFor ? labelFor(stats.ws) : stats.ws)}</span></td>
      <td>${stats.req}</td>
      <td>${stats.tokens.toLocaleString()}</td>
      <td>${stats.hitRate.toFixed(2)}%</td>
      <td><strong>$${fmtMoney(stats.cost)}</strong></td>
    `;
    wsTbody.appendChild(tr);
  }
  markSortHeader("wsTable", sortState.col, sortState.dir);
}

export function renderModelTable({ modelMap, singleModelDailyMap, selectedModel, sortState }) {
  const tableTitle = document.getElementById("tableTitle");
  const tableHead = document.getElementById("modelTableHead");
  const tbody = document.getElementById("modelTableBody");
  tbody.innerHTML = "";

  // Single explicit model -> show its per-day breakdown; otherwise the
  // aggregated Model Details table (covers "all" and multi-select).
  const singleModel = Array.isArray(selectedModel) && selectedModel.length === 1 ? selectedModel[0] : null;

  if (!singleModel) {
    tableTitle.innerText = "Model Details";
    tableHead.innerHTML = `
      <tr>
        <th data-col="model">Model</th>
        <th data-col="source">Source</th>
        <th data-col="req">Data</th>
        <th data-col="input">Input</th>
        <th data-col="output">Output</th>
        <th data-col="cacheRead">Cache Read</th>
        <th data-col="hitRate">Cache Hit Rate</th>
        <th data-col="peakCost">Peak Cost</th><th data-col="offpeakCost">Off-peak Cost</th><th data-col="flatCost">Flat Cost</th>
        <th data-col="cost">Estimated Cost</th>
      </tr>
    `;
    const modelRowsData = modelRows(modelMap);
    for (const stats of sortBy(modelRowsData, sortState.col, sortState.dir)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escHTML(stats.model)}</strong></td>
        <td>${escHTML(stats.source)}</td>
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
    tableTitle.innerText = `Daily usage for "${singleModel}"`;
    tableHead.innerHTML = `
      <tr>
        <th data-col="date">Date</th>
        <th data-col="req">Data</th>
        <th data-col="input">Input Tokens</th>
        <th data-col="output">Output Tokens</th>
        <th data-col="cacheRead">Cache Read Tokens</th>
        <th data-col="hitRate">Cache Hit Rate</th>
        <th data-col="cost">Estimated Cost</th>
      </tr>
    `;
    for (const stats of sortBy(dailyRows(singleModelDailyMap), sortState.col, sortState.dir)) {
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
  markSortHeader("modelTable", sortState.col, sortState.dir);
}

// Click a header to sort; re-render with `skipCharts` so the viewport doesn't jump.
export function wireTableSort({ sortState, onChange }) {
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
    onChange();
  });
}
