// time-reminder-view.js - Shared DOM renderer for the peak/off-peak reminder
// card. The card is rendered by both the popup (compact) and the dashboard
// (full); the markup, state text and timeline must stay identical, so both
// pages render it through here. Peak-window math lives in time-reminder.js.
//
// Callers own the actual elements (ids differ per page) and any page-specific
// extras (the dashboard also shows local/UTC clocks and a model picker).

import { isPeakAt, buildTimeline, nextPeakBoundary, formatCountdownClock } from "./time-reminder.js";

// One <div class="seg"> per local hour; the current hour is outlined.
export function timelineSegmentsHTML(peakWindows, now = new Date()) {
  const nowHour = now.getHours();
  return buildTimeline(peakWindows)
    .map(
      (seg) =>
        `<div class="seg ${seg.peak ? "peak" : ""} ${seg.hour === nowHour ? "now" : ""}" title="${String(seg.hour).padStart(2, "0")}:00"></div>`
    )
    .join("");
}

// Render the status badge, countdown and 24h timeline. Elements are optional so
// a caller that shows only part of the card can pass just those.
export function renderTimeReminderCard({ statusEl, countdownEl, timelineEl }, peakWindows, now = new Date()) {
  const peak = isPeakAt(now, peakWindows);
  const hasWindows = peakWindows.length > 0;

  if (statusEl) {
    statusEl.className = "time-status " + (hasWindows ? (peak ? "peak" : "offpeak") : "flat");
    statusEl.textContent = hasWindows ? (peak ? "PEAK" : "OFF-PEAK") : "NO RATES";
  }

  if (timelineEl) timelineEl.innerHTML = timelineSegmentsHTML(peakWindows, now);

  if (countdownEl) {
    if (hasWindows) {
      countdownEl.className = "time-countdown " + (peak ? "peak" : "offpeak");
      const boundary = nextPeakBoundary(now, peakWindows);
      countdownEl.textContent = boundary ? formatCountdownClock(boundary.time - now) : "--:--:--";
    } else {
      countdownEl.className = "time-countdown flat";
      countdownEl.textContent = "NO RATES";
    }
  }
}
