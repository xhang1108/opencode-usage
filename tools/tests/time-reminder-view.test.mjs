import { test } from "node:test";
import assert from "node:assert/strict";

import { timelineSegmentsHTML, renderTimeReminderCard } from "../../extension/shared/time-reminder-view.js";
import { isPeakAt, formatLocalTime, formatUtcTime } from "../../extension/shared/time-reminder.js";
import { flashButton } from "../../extension/shared/dom-ui.js";

// The render helpers only touch className / textContent / innerHTML, so a plain
// object stands in for a DOM element (no jsdom needed).
const el = () => ({ className: "", textContent: "", innerHTML: "" });

// Peak window is judged in UTC (see shared/time-reminder.js), so these fixtures
// are timezone-independent.
const WINDOW = [{ days: [], start: "06:00", end: "09:00" }];
const NOW_PEAK = new Date("2026-09-16T07:12:00Z"); // Wed 07:12 UTC, inside 06-09
const NOW_OFF = new Date("2026-09-16T10:00:00Z");

test("timelineSegmentsHTML emits 24 hour segments with exactly one 'now'", () => {
  const html = timelineSegmentsHTML(WINDOW, NOW_PEAK);
  const segs = html.match(/class="seg[^"]*"/g);
  assert.equal(segs.length, 24, "one segment per hour");
  assert.equal((html.match(/ now"/g) || []).length, 1, "exactly one current-hour outline");
  // The outlined segment is the local hour of `now` (matches how the popup reads it).
  const nowSeg = html.split("</div>").findIndex((s) => s.includes(" now\""));
  assert.equal(nowSeg, NOW_PEAK.getHours());
  assert.match(html, /title="07:00"/, "hour titles are zero-padded");
});

test("timelineSegmentsHTML marks the hours that are peak at the given clock", () => {
  const html = timelineSegmentsHTML(WINDOW, NOW_PEAK);
  // Count from the same construction the view uses (local hour samples -> UTC
  // classification) so the assertion is timezone-independent.
  let expected = 0;
  for (let hour = 0; hour < 24; hour++) {
    const d = new Date(NOW_PEAK);
    d.setHours(hour, 30, 0, 0);
    if (isPeakAt(d, WINDOW)) expected++;
  }
  const peaks = (html.match(/class="seg peak/g) || []).length;
  assert.equal(peaks, expected);
  assert.ok(expected > 0, "the fixture must produce at least one peak hour");
});

test("renderTimeReminderCard shows PEAK and counts down to the window end", () => {
  const statusEl = el();
  const countdownEl = el();
  const timelineEl = el();
  renderTimeReminderCard({ statusEl, countdownEl, timelineEl }, WINDOW, NOW_PEAK);

  assert.equal(statusEl.textContent, "PEAK");
  assert.equal(statusEl.className, "time-status peak");
  // 07:12 -> 09:00 is 1h48m.
  assert.equal(countdownEl.textContent, "01:48:00");
  assert.equal(countdownEl.className, "time-countdown peak");
  assert.match(timelineEl.innerHTML, /class="seg/);
});

test("renderTimeReminderCard shows OFF-PEAK and counts down to the next window", () => {
  const statusEl = el();
  const countdownEl = el();
  renderTimeReminderCard({ statusEl, countdownEl }, WINDOW, NOW_OFF);

  assert.equal(statusEl.textContent, "OFF-PEAK");
  assert.equal(statusEl.className, "time-status offpeak");
  // 10:00 today -> 06:00 tomorrow is 20h.
  assert.equal(countdownEl.textContent, "20:00:00");
  assert.equal(countdownEl.className, "time-countdown offpeak");
});

test("no peak windows reads as NO RATES (flat)", () => {
  const statusEl = el();
  const countdownEl = el();
  const timelineEl = el();
  renderTimeReminderCard({ statusEl, countdownEl, timelineEl }, [], NOW_PEAK);

  assert.equal(statusEl.textContent, "NO RATES");
  assert.equal(statusEl.className, "time-status flat");
  assert.equal(countdownEl.textContent, "NO RATES");
  assert.equal(countdownEl.className, "time-countdown flat");
});

test("renderTimeReminderCard tolerates a caller that renders only part of the card", () => {
  const statusEl = el();
  assert.doesNotThrow(() => renderTimeReminderCard({ statusEl }, WINDOW, NOW_PEAK));
  assert.equal(statusEl.textContent, "PEAK");
});

test("formatLocalTime and formatUtcTime zero-pad HH:MM", () => {
  const d = new Date("2026-09-16T07:05:00Z");
  assert.equal(formatUtcTime(d), "07:05");
  const pad = (n) => String(n).padStart(2, "0");
  assert.equal(formatLocalTime(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
});

test("flashButton swaps the label then restores it", async () => {
  const btn = { textContent: "Copy" };
  flashButton(btn, "Copied!", 5);
  assert.equal(btn.textContent, "Copied!");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(btn.textContent, "Copy");
  assert.doesNotThrow(() => flashButton(null, "x"));
});
