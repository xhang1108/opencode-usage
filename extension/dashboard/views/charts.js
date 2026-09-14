// extension/dashboard/views/charts.js
// All Chart.js rendering + the hand-rolled yearly/hourly heatmaps. State
// (chart instances, drill-down date, intraday view mode) lives in the closure.

import { localDateOf } from "../core/time.js";
import { compactTick } from "./format.js";

// Single desaturated brand blue (#6a8fc0) with opacity variants.
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

// `getRecords()` -> canonical records; `getPrice(rec)` -> { cost, savings, ... };
// `getFilters()` -> { selectedWorkspace, selectedModel }.
export function createCharts({ getRecords, getPrice, getFilters }) {
  let dailyChartInst = null;
  let hourlyChartInst = null;
  let modelChartInst = null;
  let tokenTypeChartInst = null;
  let hitRateChartInst = null;

  // null = fall back to the last day of the selected range.
  let selectedHourlyDate = null;
  let hourlyView = "hybrid"; // hybrid | heatmap
  let lastHourlyMap = null;
  let lastHourlyDate = null;
  let lastFullHourlyMap = null; // full-range map for the yearly calendar drill-down

  // Intraday drill-down: one day's cost/token curve. Clicking a point on the
  // daily chart pins that day; otherwise defaults to the range's last day.
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

  // 24h x 60min grid, colored by cost intensity.
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
      "display:grid; grid-template-columns: 30px repeat(60, minmax(0, 1fr)); gap:1px; " +
      "font-family:var(--font-mono); font-size:9px; color:var(--text-muted); align-items:center;";

    const label = (text, align) => {
      const d = document.createElement("div");
      d.textContent = text;
      d.style.cssText = `text-align:${align}; padding:0 4px;`;
      return d;
    };

    const tip = document.createElement("div");
    tip.style.cssText =
      "position:fixed; pointer-events:none; z-index:60; display:none; " +
      "background:var(--surface); border:1px solid var(--border); border-radius:6px; " +
      "padding:8px 10px; font-family:var(--font-mono); font-size:11px; color:var(--text); " +
      "box-shadow:0 4px 16px rgba(0,0,0,.4);";
    wrap.appendChild(tip);

    grid.appendChild(label("", "right"));
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
            tip.style.left = e.clientX + 14 + "px";
            tip.style.top = e.clientY + 14 + "px";
          });
          cell.addEventListener("mouseleave", () => {
            tip.style.display = "none";
          });
        }
        grid.appendChild(cell);
      }
    }
    wrap.appendChild(grid);
  }

  // 24 hourly points styled like the Daily Cost chart (dual axes).
  function renderHourlyHybrid(hourlyMap, date) {
    const dayData = hourlyMap[date] || {};
    const labels = [];
    const costs = [];
    const tokens = [];
    for (let h = 0; h < 24; h++) {
      let c = 0;
      let t = 0;
      for (let m = h * 60; m < h * 60 + 60; m++) {
        if (dayData[m]) {
          c += dayData[m].cost;
          t += dayData[m].tokens;
        }
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
          { label: "Token Volume", data: tokens, borderColor: CHART_COLORS.blueDim, yAxisID: "yToken", borderDash: [5, 5], tension: 0.3 },
        ],
      },
      options: chartOptions({
        interaction: { mode: "index", intersect: false },
        scales: {
          x: axis({ ticks: { maxRotation: 0, minRotation: 0, autoSkip: true } }),
          yCost: axis({ type: "linear", position: "left" }),
          yToken: axis({ type: "linear", position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v) => compactTick(v) } }),
        },
      }),
    });
  }

  // Daily cost + token trend; click a day to drill into the 24h chart.
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
          { label: "Token Volume", data: dailyTokens, borderColor: CHART_COLORS.blueDim, yAxisID: "yToken", borderDash: [5, 5], tension: 0.3 },
        ],
      },
      options: chartOptions({
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
              maxRotation: 0,
              minRotation: 0,
              autoSkip: true,
              maxTicksLimit: 12,
              callback: (value, index) => {
                const d = dates[index];
                if (!d) return "";
                return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
              },
            },
          }),
          yCost: axis({ type: "linear", position: "left" }),
          yToken: axis({ type: "linear", position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v) => compactTick(v) } }),
        },
      }),
    });
  }

  // GitHub-style yearly calendar (365 days), filtered by ws/model but not by
  // date range. Click a day to drill into the 24h chart.
  function renderYearlyHeatmap() {
    const wrap = document.getElementById("yearlyHeatmapWrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    const { selectedWorkspace, selectedModel } = getFilters();

    const daily = {};
    const hourly = {};
    for (const rec of getRecords()) {
      const wsID = rec.workspaceID || "wrk_unknown";
      const wsKey = `${rec.source || "opencode"}:${wsID}`;
      const modelName = rec.model || "Unknown";
      if (selectedWorkspace.length && !selectedWorkspace.includes(wsKey)) continue;
      if (selectedModel.length && !selectedModel.includes(modelName)) continue;
      const date = localDateOf(rec);
      if (!date) continue;
      const { cost } = getPrice(rec);
      const tokens =
        (rec.input || 0) + (rec.output || 0) + (rec.reasoning || 0) + (rec.cacheRead || 0) + (rec.cacheWrite5m || 0) + (rec.cacheWrite1h || 0);
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

    const lastDate = new Date(dates[dates.length - 1] + "T00:00:00");
    const firstDate = new Date(lastDate);
    firstDate.setDate(firstDate.getDate() - 364);

    const start = new Date(firstDate);
    start.setDate(firstDate.getDate() - ((firstDate.getDay() + 6) % 7));
    const end = new Date(lastDate);
    end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));

    const weeks = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      weeks.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }

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
      "display:grid; width:100%; gap:" +
      GAP +
      "px; " +
      `grid-template-columns: repeat(${weeks.length}, minmax(0, 1fr)); ` +
      "grid-template-rows: 18px repeat(7, auto); " +
      "font-family:var(--font-mono); font-size:9px; color:var(--text-muted);";

    const tip = document.createElement("div");
    tip.style.cssText =
      "position:fixed; pointer-events:none; z-index:60; display:none; " +
      "background:var(--surface); border:1px solid var(--border); border-radius:6px; " +
      "padding:8px 10px; font-family:var(--font-mono); font-size:11px; color:var(--text); " +
      "box-shadow:0 4px 16px rgba(0,0,0,.4);";
    wrap.appendChild(tip);

    for (const g of monthGroups) {
      const name = new Date(g.year, g.month, 1).toLocaleDateString("en-US", { month: "short" });
      const el = label(name, "left");
      el.style.gridColumn = `span ${g.count}`;
      grid.appendChild(el);
    }

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
            tip.style.left = e.clientX + 14 + "px";
            tip.style.top = e.clientY + 14 + "px";
          });
          cell.addEventListener("mouseleave", () => {
            tip.style.display = "none";
          });
          cell.addEventListener("click", () => {
            selectedHourlyDate = key;
            renderHourlyChart(lastFullHourlyMap, key);
          });
        }
        grid.appendChild(cell);
      }
    }

    wrap.appendChild(grid);

    const legend = document.createElement("div");
    legend.style.cssText =
      "display:flex; justify-content:center; align-items:center; gap:4px; margin-top:10px; font-family:var(--font-mono); font-size:10px; color:var(--text-muted);";
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

  function renderModelCharts(modelMap) {
    const entries = Object.values(modelMap);
    // Same-named models from different sources are separate entries; label the
    // source only when the name is ambiguous.
    const nameCount = {};
    for (const s of entries) nameCount[s.model] = (nameCount[s.model] || 0) + 1;
    const labels = entries.map((s) => (nameCount[s.model] > 1 ? `${s.model} (${s.source})` : s.model));
    const modelCosts = entries.map((s) => s.cost);
    if (modelChartInst) modelChartInst.destroy();
    modelChartInst = new Chart(document.getElementById("modelChart"), {
      type: "doughnut",
      data: {
        labels,
        datasets: [{ data: modelCosts, backgroundColor: monoTones(modelCosts.length), borderWidth: 0, hoverBorderWidth: 0 }],
      },
      options: chartOptions({ plugins: { legend: { position: "bottom" } } }),
    });

    const inputs = entries.map((s) => s.input);
    const cacheReads = entries.map((s) => s.cacheRead);
    if (tokenTypeChartInst) tokenTypeChartInst.destroy();
    tokenTypeChartInst = new Chart(document.getElementById("tokenTypeChart"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Real Input Tokens", data: inputs, backgroundColor: CHART_COLORS.blue },
          { label: "Cache Read Tokens", data: cacheReads, backgroundColor: CHART_COLORS.blueDim },
        ],
      },
      options: chartOptions({ scales: { x: axis({ stacked: true }), y: axis({ stacked: true }) } }),
    });

    const hitRates = entries.map((s) => {
      const prompt = s.input + s.cacheRead;
      return prompt > 0 ? parseFloat(((s.cacheRead / prompt) * 100).toFixed(2)) : 0;
    });
    if (hitRateChartInst) hitRateChartInst.destroy();
    hitRateChartInst = new Chart(document.getElementById("hitRateChart"), {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Cache Hit Rate (%)", data: hitRates, backgroundColor: CHART_COLORS.blue }],
      },
      options: chartOptions({ scales: { x: axis(), y: axis({ max: 100 }) } }),
    });
  }

  function renderDashboardCharts({ dailyMap, dailyTokenMap, hourlyMap, modelMap, endDate }) {
    renderDailyLine(dailyMap, dailyTokenMap, hourlyMap, endDate);
    renderHourlyChart(hourlyMap, endDate);
    renderModelCharts(modelMap);
  }

  function wire() {
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
  }

  return {
    wire,
    renderDashboardCharts,
    renderYearlyHeatmap,
    resetSelectedDate: () => {
      selectedHourlyDate = null;
    },
  };
}
