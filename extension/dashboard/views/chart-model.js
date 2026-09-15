// extension/dashboard/views/chart-model.js
// Pure data shaping for the charts: heatmap shading, the yearly calendar grid,
// the 24-hour buckets and the model chart series. charts.js keeps only the
// Chart.js / DOM wiring. No DOM, no chrome.

// Heatmap cell shading: sqrt ramp so low values stay visible; `min` keeps each
// heatmap's own floor, `cost == null` means "no data".
export const heatOpacity = (cost, max, min) => (cost == null ? 0.03 : Math.max(min, Math.sqrt(cost / max)));

// Local "YYYY-MM-DD" for a Date.
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// GitHub-style calendar geometry: a 365-day window ending on the latest date,
// padded to whole Monday–Sunday weeks. Returns null when there is no data.
//   weeks       - one Date per column (the Monday of each week)
//   monthGroups - [{ key, year, month, count }] label cells spanning columns
export function yearlyGrid(dateKeys) {
  const dates = [...(dateKeys || [])].sort();
  if (dates.length === 0) return null;

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
  return { weeks, monthGroups, firstDate, lastDate };
}

// 24 hourly points (cost + tokens) from a day's minute-indexed map.
export function hourlyBuckets(dayData) {
  const labels = [];
  const costs = [];
  const tokens = [];
  for (let h = 0; h < 24; h++) {
    let c = 0;
    let t = 0;
    for (let m = h * 60; m < h * 60 + 60; m++) {
      if (dayData && dayData[m]) {
        c += dayData[m].cost;
        t += dayData[m].tokens;
      }
    }
    labels.push(`${String(h).padStart(2, "0")}:00`);
    costs.push(c);
    tokens.push(t);
  }
  return { labels, costs, tokens };
}

// Per-model series for the doughnut / input-vs-cache / hit-rate charts. Entries
// are the aggregated model map; a model name shared by several sources is
// disambiguated with its source.
export function modelChartSeries(modelMap) {
  const entries = Object.values(modelMap || {});
  const nameCount = {};
  for (const s of entries) nameCount[s.model] = (nameCount[s.model] || 0) + 1;
  return {
    labels: entries.map((s) => (nameCount[s.model] > 1 ? `${s.model} (${s.source})` : s.model)),
    costs: entries.map((s) => s.cost),
    inputs: entries.map((s) => s.input),
    cacheReads: entries.map((s) => s.cacheRead),
    hitRates: entries.map((s) => {
      const prompt = s.input + s.cacheRead;
      return prompt > 0 ? parseFloat(((s.cacheRead / prompt) * 100).toFixed(2)) : 0;
    }),
  };
}
