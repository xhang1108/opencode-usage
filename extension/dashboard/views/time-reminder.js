// extension/dashboard/views/time-reminder.js
// Peak/off-peak reminder card. Peak-window math lives in shared/time-reminder.js
// (imported module); this module owns the DOM + 1s ticker.

import {
  TIME_RATES_KEY,
  collectPeakWindowsForModel,
  formatLocalTime,
  formatUtcTime,
  isPeakAt,
  buildTimeline,
  nextPeakBoundary,
  formatCountdownClock,
  listPeakModels,
  loadTimeModel,
  saveTimeModel,
  loadTimeEnabled,
  saveTimeEnabled,
} from "../../shared/time-reminder.js";

// `getRateModels()` -> [{ model, rates }] derived from the live pricing config.
export function createTimeReminder({ getRateModels }) {
  const timeStatusEl = document.getElementById("time-status");
  const timeCountdownEl = document.getElementById("time-countdown");
  const timeLocalEl = document.getElementById("time-local");
  const timeUtcEl = document.getElementById("time-utc");
  const timeTimelineEl = document.getElementById("time-timeline");
  const timeToggleEl = document.getElementById("time-toggle");
  const timeModelEl = document.getElementById("time-model");

  let timeSelectedModel = "";
  let timePeakWindows = [];

  // Mirror the live rate config into chrome.storage so the popup/background can
  // read the peak windows (they can't see the dashboard's config object).
  function mirrorRates() {
    try {
      chrome.storage.local.set({ [TIME_RATES_KEY]: getRateModels() });
    } catch (e) {}
  }

  function refreshTimePeakWindows() {
    timePeakWindows = collectPeakWindowsForModel(getRateModels(), timeSelectedModel);
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
      .map(
        (seg) =>
          `<div class="seg ${seg.peak ? "peak" : ""} ${seg.hour === nowHour ? "now" : ""}" title="${String(seg.hour).padStart(2, "0")}:00"></div>`
      )
      .join("");

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
    const models = listPeakModels(getRateModels());
    timeModelEl.innerHTML = '<option value="">Select model</option>' + models.map((m) => `<option value="${m}">${m}</option>`).join("");
    return models;
  }

  // (Re)build the model picker from the live rate config and reconcile the
  // stored selection. Called after settings load and whenever the config
  // changes; the dashboard calls it directly instead of relying on the
  // storage change event (an identical rewrite does not always fire one).
  async function reloadModels() {
    if (!timeModelEl) return [];
    const names = populateTimeModels();
    const stored = await loadTimeModel();
    const storedValid = stored === "" || names.includes(stored);
    const selected = storedValid ? stored || "" : names[0] || "";
    timeModelEl.value = selected;
    timeSelectedModel = selected;
    if (stored !== selected) await saveTimeModel(selected).catch(() => {});
    refreshTimePeakWindows();
    renderTimeReminder();
    return names;
  }

  async function init() {
    timeToggleEl.checked = await loadTimeEnabled();
    timeToggleEl.addEventListener("change", () => saveTimeEnabled(timeToggleEl.checked));

    await reloadModels();

    timeModelEl.addEventListener("change", async () => {
      timeSelectedModel = timeModelEl.value;
      await saveTimeModel(timeModelEl.value).catch(() => {});
      refreshTimePeakWindows();
      renderTimeReminder();
    });

    // Rebuild the cached windows whenever the mirrored rate config changes
    // (after settings saves/resets/imports).
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === "local" && changes[TIME_RATES_KEY]) {
        await reloadModels();
      }
    });

    renderTimeReminder();
    setInterval(renderTimeReminder, 1000);
  }

  return { init, mirrorRates, reloadModels, refreshTimePeakWindows, renderTimeReminder };
}
