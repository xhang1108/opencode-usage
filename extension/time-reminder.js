// time-reminder.js - Shared time-reminder logic for the popup and dashboard.
// Reads the model rate settings (peak windows) that the dashboard stores, and
// provides: current peak/off-peak status, a 24h timeline, and local<->UTC helpers.
//
// Storage contract:
//   - The dashboard keeps the authoritative rate config in its own localStorage
//     (key "opencode_model_rates_v2"). Because popup/background can't read that
//     page's localStorage, the dashboard mirrors the config into
//     chrome.storage.local under TIME_RATES_KEY whenever it loads/saves.
//   - The reminder toggle lives in chrome.storage.local under TIME_ENABLED_KEY.
//   - The selected model lives in chrome.storage.local under TIME_MODEL_KEY.
//
// Peak/off-peak is derived from the selected model's peak windows: if the
// current time falls inside that model's peak window, it is "peak"; otherwise
// "off-peak". This keeps the reminder in sync with the rate settings without
// hard-coding any times.

const TIME_RATES_KEY = "opencode_time_rates";
const TIME_ENABLED_KEY = "opencode_time_reminder_enabled";
const TIME_MODEL_KEY = "opencode_time_model";

// Parse "HH:MM" -> minutes since midnight; null when malformed.
function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Extract the union of all peak windows from a rate config (array of rules).
// Each window: { days: number[], start: "HH:MM", end: "HH:MM" }.
function collectPeakWindows(models) {
  const windows = [];
  if (!Array.isArray(models)) return windows;
  for (const rule of models) {
    const rates = rule && rule.rates;
    if (!Array.isArray(rates)) continue;
    for (const version of rates) {
      const peak = version && version.windows && version.windows.peak;
      if (!Array.isArray(peak)) continue;
      for (const w of peak) {
        if (w && w.start && w.end) windows.push({ days: w.days || [], start: w.start, end: w.end });
      }
    }
  }
  return windows;
}

// List the model names that have at least one peak window (candidates for the
// time-reminder model selector).
function listPeakModels(models) {
  const names = [];
  if (!Array.isArray(models)) return names;
  for (const rule of models) {
    const rates = rule && rule.rates;
    if (!Array.isArray(rates) || !rule.model) continue;
    const hasPeak = rates.some(
      (v) => v && v.windows && Array.isArray(v.windows.peak) && v.windows.peak.length > 0
    );
    if (hasPeak) names.push(rule.model);
  }
  return names;
}

// Collect the peak windows for a single model.
function collectPeakWindowsForModel(models, modelName) {
  if (!Array.isArray(models)) return [];
  const rule = models.find((r) => r && r.model === modelName);
  if (!rule) return [];
  return collectPeakWindows([rule]);
}

// Load the selected model name from chrome.storage.local.
async function loadTimeModel() {
  const { [TIME_MODEL_KEY]: model } = await chrome.storage.local.get(TIME_MODEL_KEY);
  return model || null;
}

// Save the selected model name to chrome.storage.local.
async function saveTimeModel(model) {
  await chrome.storage.local.set({ [TIME_MODEL_KEY]: model || "" });
}

// Is the given Date inside any peak window? Uses UTC (matching the rate logic).
function isPeakAt(date, peakWindows) {
  if (!peakWindows || peakWindows.length === 0) return false;
  const weekday = date.getUTCDay();
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  for (const w of peakWindows) {
    const days = w.days || [];
    if (days.length > 0 && !days.includes(weekday)) continue;
    const start = timeToMinutes(w.start);
    const end = timeToMinutes(w.end);
    if (start == null || end == null) continue;
    if (start <= end) {
      if (minutes >= start && minutes < end) return true;
    } else {
      // Crosses midnight: after start or before end
      if (minutes >= start || minutes < end) return true;
    }
  }
  return false;
}

// Load the mirrored rate config from chrome.storage.local.
async function loadTimeRates() {
  const { [TIME_RATES_KEY]: rates } = await chrome.storage.local.get(TIME_RATES_KEY);
  return rates || null;
}

// Load the reminder toggle state.
async function loadTimeEnabled() {
  const { [TIME_ENABLED_KEY]: enabled } = await chrome.storage.local.get(TIME_ENABLED_KEY);
  return enabled !== false; // default on
}

// Save the reminder toggle state.
async function saveTimeEnabled(enabled) {
  await chrome.storage.local.set({ [TIME_ENABLED_KEY]: !!enabled });
}

// Build a 24h timeline (one entry per local hour) marking each hour as
// peak/off-peak, based on the union of peak windows. The timeline is laid out
// in local time (00:00-24:00), matching how the user reads the clock.
function buildTimeline(peakWindows) {
  const timeline = [];
  const now = new Date();
  for (let hour = 0; hour < 24; hour++) {
    // Sample the middle of each local hour so boundary hours resolve deterministically.
    const d = new Date(now);
    d.setHours(hour, 30, 0, 0);
    timeline.push({ hour, peak: isPeakAt(d, peakWindows) });
  }
  return timeline;
}

// Compute the start/end UTC Date for a peak window on a given UTC day.
// Handles windows that cross midnight (start > end): the end lands on the next day.
function windowBoundariesForDate(day, w) {
  const start = timeToMinutes(w.start);
  const end = timeToMinutes(w.end);
  const startDate = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Math.floor(start / 60), start % 60));
  const endDate =
    start <= end
      ? new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Math.floor(end / 60), end % 60))
      : new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, Math.floor(end / 60), end % 60));
  return { start: startDate, end: endDate };
}

// Find the next peak boundary (start or end) after `now`. Returns
// { time: Date, type: "start" | "end" } or null when there are no windows.
// When currently in peak, the next boundary is the peak end (back to off-peak);
// when off-peak, it is the next peak start.
function nextPeakBoundary(now, peakWindows) {
  if (!peakWindows || peakWindows.length === 0) return null;
  const candidates = [];
  // Scan a full week so windows restricted to a specific weekday are found even
  // when that day is several days away. A cross-midnight window's end can land
  // on the following day, so 7 days covers every window's start and end.
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    const weekday = day.getUTCDay();
    for (const w of peakWindows) {
      const days = w.days || [];
      if (days.length > 0 && !days.includes(weekday)) continue;
      const b = windowBoundariesForDate(day, w);
      if (b.start > now) candidates.push({ time: b.start, type: "start" });
      if (b.end > now) candidates.push({ time: b.end, type: "end" });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.time - b.time);
  return candidates[0];
}

// Format a millisecond countdown as "HH:MM:SS" (ticks every second).
function formatCountdownClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Format a Date in the local timezone as "HH:MM".
function formatLocalTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Format a Date in UTC as "HH:MM".
function formatUtcTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
