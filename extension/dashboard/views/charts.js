// extension/dashboard/views/charts.js
// All Chart.js rendering + the hand-rolled yearly/hourly heatmaps. State
// (chart instances, drill-down date, intraday view mode) lives in the closure.

import { compactTick } from "./format.js";
import { heatOpacity, isoDate, yearlyGrid, heatmapCells, hourlyBuckets, modelChartSeries } from "./chart-model.js";

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

// Heatmap cell shading lives in chart-model.js (heatOpacity).

// Grid label cell shared by both heatmaps.
function axisLabel(text, align) {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.cssText = `text-align:${align}; padding:0 4px;`;
  return d;
}

// Fixed-position hover tooltip shared by both heatmaps.
function createHeatmapTooltip(wrap) {
  const tip = document.createElement("div");
  tip.style.cssText =
    "position:fixed; pointer-events:none; z-index:60; display:none; " +
    "background:var(--surface); border:1px solid var(--border); border-radius:6px; " +
    "padding:8px 10px; font-family:var(--font-mono); font-size:11px; color:var(--text); " +
    "box-shadow:0 4px 16px rgba(0,0,0,.4);";
  wrap.appendChild(tip);
  const place = (x, y) => {
    tip.style.left = x + 14 + "px";
    tip.style.top = y + 14 + "px";
  };
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.style.display = "block";
      place(x, y);
    },
    move: place,
    hide() {
      tip.style.display = "none";
    },
  };
}

// Tooltip body shared by both heatmaps.
const heatmapTipHTML = (heading, cost, tokens) =>
  `<div style="color:var(--text-muted); margin-bottom:4px;">${heading}</div>` +
  `Cost: <strong>$${cost.toFixed(4)}</strong><br>` +
  `Tokens: <strong>${tokens.toLocaleString()}</strong>`;

// `isReady()` (optional) gates the view-toggle buttons until the first load has
// completed, so a click can't drill into a chart built from a null map. Record
// data is supplied per render (by the aggregate pass), not read from getters.
export function createCharts({ isReady } = {}) {
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
  // Reused yearly-heatmap grid: { key, cells } from the last full build.
  let yearlyCache = null;

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

    const wrap = document.getElementById("hourlyChartWrap");
    const canvas = document.getElementById("hourlyChart");
    const removeGrid = () => {
      const oldGrid = wrap && wrap.querySelector(".heatmap");
      if (oldGrid) oldGrid.remove();
    };

    if (!hourlyDate) {
      if (hourlyChartInst) hourlyChartInst.destroy();
      hourlyChartInst = null;
      removeGrid();
      if (canvas) canvas.style.display = "";
      return;
    }

    if (hourlyView === "heatmap") {
      // The heatmap is a DOM grid, not a canvas chart; drop the line chart if present.
      if (hourlyChartInst) hourlyChartInst.destroy();
      hourlyChartInst = null;
      removeGrid();
      if (canvas) canvas.style.display = "none";
      renderHourlyHeatmap(hourlyMap, hourlyDate);
      return;
    }

    // Hybrid view: keep the existing line chart and mutate its data in place.
    removeGrid();
    if (canvas) canvas.style.display = "";
    renderHourlyHybrid(hourlyMap, hourlyDate);
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

    const tooltip = createHeatmapTooltip(wrap);

    grid.appendChild(axisLabel("", "right"));
    for (let m = 0; m < 60; m++) grid.appendChild(axisLabel(m % 15 === 0 ? String(m).padStart(2, "0") : "", "center"));
    for (let h = 0; h < 24; h++) {
      grid.appendChild(axisLabel(String(h).padStart(2, "0"), "right"));
      for (let m = 0; m < 60; m++) {
        const idx = h * 60 + m;
        const d = dayData[idx];
        const cell = document.createElement("div");
        const opacity = heatOpacity(d ? d.cost : null, maxCost, 0.1);
        cell.style.cssText = `background: rgba(106,143,192,${opacity}); border-radius:1px; aspect-ratio:1;`;
        if (d) {
          const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          cell.addEventListener("mouseenter", (e) => tooltip.show(heatmapTipHTML(time, d.cost, d.tokens), e.clientX, e.clientY));
          cell.addEventListener("mousemove", (e) => tooltip.move(e.clientX, e.clientY));
          cell.addEventListener("mouseleave", () => tooltip.hide());
        }
        grid.appendChild(cell);
      }
    }
    wrap.appendChild(grid);
  }

  // 24 hourly points styled like the Daily Cost chart (dual axes).
  function renderHourlyHybrid(hourlyMap, date) {
    const dayData = hourlyMap[date] || {};
    const { labels, costs, tokens } = hourlyBuckets(dayData);
    if (hourlyChartInst) {
      hourlyChartInst.data.labels = labels;
      hourlyChartInst.data.datasets[0].data = costs;
      hourlyChartInst.data.datasets[1].data = tokens;
      hourlyChartInst.update("none");
      return;
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
    const dates = Object.keys(dailyMap).sort();
    const dailyCosts = dates.map((d) => dailyMap[d]);
    const dailyTokens = dates.map((d) => dailyTokenMap[d]);

    if (dailyChartInst) {
      dailyChartInst.data.labels = dates;
      dailyChartInst.data.datasets[0].data = dailyCosts;
      dailyChartInst.data.datasets[1].data = dailyTokens;
      dailyChartInst.update("none");
      return;
    }

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
              // Use the latest drill-down map, not the one captured at creation:
              // this chart is now updated in place, so its closure would be stale.
              renderHourlyChart(lastHourlyMap, lastHourlyDate);
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
              // Read labels off the chart so an in-place update keeps the
              // formatted dates in sync (a captured array would go stale).
              callback(value, index) {
                const d = this.chart.data.labels[index];
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

  // Apply a heatmapCells() plan to existing cell elements in place. Repaints the
  // background only when the shade actually moved, and stores each cell's data on
  // the element so the reused hover/click listeners always read current values.
  function applyYearlyCells(cellEls, cells) {
    for (let i = 0; i < cellEls.length; i++) {
      const el = cellEls[i];
      const c = cells[i];
      el._hm = c;
      if (el._hmOp !== c.opacity) {
        el.style.background = `rgba(106,143,192,${c.opacity})`;
        el._hmOp = c.opacity;
      }
      el.style.cursor = c.has ? "pointer" : "";
    }
  }

  // GitHub-style yearly calendar (365 days), filtered by ws/model but not by
  // date range. `dailyAll`/`hourlyAll` come from the aggregate pass (Step 9), so
  // this no longer scans the records. The grid is expensive (~371 cells), so when
  // the week layout is unchanged we reuse the cells and repaint only moved shades.
  function renderYearlyHeatmap(dailyAll, hourlyAll) {
    const wrap = document.getElementById("yearlyHeatmapWrap");
    if (!wrap) return;

    const daily = dailyAll || {};
    lastFullHourlyMap = hourlyAll || {};

    const dates = Object.keys(daily).sort();
    if (dates.length === 0) {
      wrap.innerHTML = '<div class="notice">No data for the current filters.</div>';
      yearlyCache = null;
      return;
    }

    const { weeks, monthGroups, firstDate, lastDate } = yearlyGrid(dates);

    let maxCost = 0;
    for (const d of dates) if (daily[d].cost > maxCost) maxCost = daily[d].cost;

    const cells = heatmapCells(daily, weeks, maxCost, 0.08);
    const cacheKey = weeks.map((d) => d.getTime()).join(",") + "|" + monthGroups.map((g) => `${g.key}:${g.count}`).join(",");

    const badge = document.getElementById("yearlyRange");
    if (badge) badge.textContent = `${isoDate(firstDate)} → ${isoDate(lastDate)}`;

    if (yearlyCache && yearlyCache.key === cacheKey) {
      applyYearlyCells(yearlyCache.cells, cells);
      return;
    }

    // Full rebuild: the week layout changed, so the grid, month header and
    // tooltip are recreated too.
    wrap.innerHTML = "";
    const GAP = 2;
    const grid = document.createElement("div");
    grid.style.cssText =
      "display:grid; width:100%; gap:" +
      GAP +
      "px; " +
      `grid-template-columns: repeat(${weeks.length}, minmax(0, 1fr)); ` +
      "grid-template-rows: 18px repeat(7, auto); " +
      "font-family:var(--font-mono); font-size:9px; color:var(--text-muted);";

    const tooltip = createHeatmapTooltip(wrap);

    for (const g of monthGroups) {
      const name = new Date(g.year, g.month, 1).toLocaleDateString("en-US", { month: "short" });
      const el = axisLabel(name, "left");
      el.style.gridColumn = `span ${g.count}`;
      grid.appendChild(el);
    }

    const cellEls = [];
    for (let i = 0; i < cells.length; i++) {
      const cell = document.createElement("div");
      cell.style.cssText = "width:100%; aspect-ratio:1; border:1px solid rgba(255,255,255,0.05); border-radius:2px;";
      // Listeners read the cell's current data at event time, so reusing a cell
      // after an in-place update never shows stale values.
      cell.addEventListener("mouseenter", (e) => {
        const c = cell._hm;
        if (c && c.has) tooltip.show(heatmapTipHTML(c.key, c.cost, c.tokens), e.clientX, e.clientY);
      });
      cell.addEventListener("mousemove", (e) => tooltip.move(e.clientX, e.clientY));
      cell.addEventListener("mouseleave", () => tooltip.hide());
      cell.addEventListener("click", () => {
        const c = cell._hm;
        if (!c || !c.has) return;
        selectedHourlyDate = c.key;
        renderHourlyChart(lastFullHourlyMap, c.key);
      });
      grid.appendChild(cell);
      cellEls.push(cell);
    }
    applyYearlyCells(cellEls, cells);
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

    yearlyCache = { key: cacheKey, cells: cellEls };
  }

  function renderModelCharts(modelMap) {
    // Same-named models from different sources are separate entries; label the
    // source only when the name is ambiguous.
    const { labels, costs: modelCosts, inputs, cacheReads, hitRates } = modelChartSeries(modelMap);

    if (modelChartInst) {
      modelChartInst.data.labels = labels;
      modelChartInst.data.datasets[0].data = modelCosts;
      // A doughnut's slice colours are positional, so they must follow the new
      // slice count whenever the label set changes.
      modelChartInst.data.datasets[0].backgroundColor = monoTones(modelCosts.length);
      modelChartInst.update("none");
    } else {
      modelChartInst = new Chart(document.getElementById("modelChart"), {
        type: "doughnut",
        data: {
          labels,
          datasets: [{ data: modelCosts, backgroundColor: monoTones(modelCosts.length), borderWidth: 0, hoverBorderWidth: 0 }],
        },
        options: chartOptions({ plugins: { legend: { position: "bottom" } } }),
      });
    }

    if (tokenTypeChartInst) {
      tokenTypeChartInst.data.labels = labels;
      tokenTypeChartInst.data.datasets[0].data = inputs;
      tokenTypeChartInst.data.datasets[1].data = cacheReads;
      tokenTypeChartInst.update("none");
    } else {
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
    }

    if (hitRateChartInst) {
      hitRateChartInst.data.labels = labels;
      hitRateChartInst.data.datasets[0].data = hitRates;
      hitRateChartInst.update("none");
    } else {
      hitRateChartInst = new Chart(document.getElementById("hitRateChart"), {
        type: "bar",
        data: {
          labels,
          datasets: [{ label: "Cache Hit Rate (%)", data: hitRates, backgroundColor: CHART_COLORS.blue }],
        },
        options: chartOptions({ scales: { x: axis(), y: axis({ max: 100 }) } }),
      });
    }
  }

  function renderDashboardCharts({ dailyMap, dailyTokenMap, hourlyMap, modelMap, endDate }) {
    renderDailyLine(dailyMap, dailyTokenMap, hourlyMap, endDate);
    renderHourlyChart(hourlyMap, endDate);
    renderModelCharts(modelMap);
  }

  function wire() {
    const ready = typeof isReady === "function" ? isReady : () => true;
    document.querySelectorAll(".hourly-view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!ready()) return;
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
