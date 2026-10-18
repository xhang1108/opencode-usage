// extension/dashboard/settings/spend.js
// Settings → Spend: manual USD spend ledger per platform/date.

import { saveSpendEntries } from "./store.js";
import { normalizeSpendEntry, validateSpendEntry, aggregateSpend } from "../../shared/spend.js";
import { escHTML, fmtMoney } from "../views/format.js";
import { initCustomSelect, renderCalendarGrid, shiftViewMonth } from "../views/filters.js";
import { todayISO } from "../core/time.js";
import { platformOptions, spendTableRows, spendSummary } from "./spend-model.js";

let editingId = null;
let platformSelect = null;
const spendDateState = { date: "", viewYear: null, viewMonth: null };

function ensurePlatformSelect() {
  if (!platformSelect) {
    platformSelect = initCustomSelect(
      "spendPlatform",
      "spendPlatformTrigger",
      "spendPlatformLabel",
      "spendPlatformPanel",
      "spendPlatformOptions"
    );
  }
  return platformSelect;
}

function vendorsOf(ctx) {
  return (ctx.settings.registry && ctx.settings.registry.vendors) || [];
}

function labelOf(vendors, entry) {
  return (vendors.find((v) => v.source === entry.platform) || {}).label || entry.platformLabel || entry.platform;
}

function updateSpendDateLabel() {
  const label = document.getElementById("spendDateLabel");
  if (label) label.textContent = spendDateState.date || "Select date";
}

function renderSpendDateCalendar() {
  const monthLabel = document.getElementById("spendDateMonth");
  const weekdays = document.getElementById("spendDateWeekdays");
  const days = document.getElementById("spendDateDays");
  if (!monthLabel || !weekdays || !days) return;
  if (spendDateState.viewYear === null) {
    const ref = spendDateState.date || todayISO();
    spendDateState.viewYear = +ref.slice(0, 4);
    spendDateState.viewMonth = +ref.slice(5, 7) - 1;
  }
  monthLabel.textContent = new Date(spendDateState.viewYear, spendDateState.viewMonth, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  renderCalendarGrid(
    weekdays,
    days,
    spendDateState.viewYear,
    spendDateState.viewMonth,
    (btn, iso) => {
      if (iso === spendDateState.date) btn.classList.add("range-start", "range-end");
    },
    (iso) => {
      spendDateState.date = iso;
      const hidden = document.getElementById("spendDate");
      if (hidden) hidden.value = iso;
      updateSpendDateLabel();
      closeSpendDatePicker();
    }
  );
}

function openSpendDatePicker() {
  const popup = document.getElementById("spendDatePopup");
  const trigger = document.getElementById("spendDateTrigger");
  if (!popup || !trigger) return;
  if (spendDateState.viewYear === null) {
    const ref = spendDateState.date || todayISO();
    spendDateState.viewYear = +ref.slice(0, 4);
    spendDateState.viewMonth = +ref.slice(5, 7) - 1;
  }
  renderSpendDateCalendar();
  popup.hidden = false;
  trigger.classList.add("open");
}

function closeSpendDatePicker() {
  const popup = document.getElementById("spendDatePopup");
  const trigger = document.getElementById("spendDateTrigger");
  if (popup) popup.hidden = true;
  if (trigger) trigger.classList.remove("open");
}

function resetSpendForm() {
  const dateHidden = document.getElementById("spendDate");
  if (dateHidden) dateHidden.value = "";
  spendDateState.date = "";
  spendDateState.viewYear = null;
  spendDateState.viewMonth = null;
  updateSpendDateLabel();
  const amount = document.getElementById("spendAmount");
  if (amount) amount.value = "";
  const note = document.getElementById("spendNote");
  if (note) note.value = "";
}

export function renderSpend(ctx) {
  const vendors = vendorsOf(ctx);
  const entries = ctx.settings.spendEntries || [];
  if (editingId && !entries.some((e) => e.id === editingId)) {
    editingId = null;
  }

  const opts = platformOptions(vendors);
  const sel = document.getElementById("spendPlatform");
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = opts.map((o) => `<option value="${escHTML(o.value)}">${escHTML(o.label)}</option>`).join("");
    if (opts.some((o) => o.value === prev)) sel.value = prev;
    ensurePlatformSelect().refresh();
  }

  const summary = spendSummary(entries);
  const tableWrap = document.getElementById("spendTable");
  if (tableWrap) {
    const rows = spendTableRows(entries, { sortBy: "date", sortDir: -1 });
    if (rows.length === 0) {
      tableWrap.innerHTML = '<div class="notice">No spend entries yet.</div>';
    } else {
      tableWrap.innerHTML =
        '<table class="db-table"><thead><tr><th>Date</th><th>Platform</th><th>Amount (USD)</th><th>Note</th><th></th></tr></thead><tbody>' +
        rows.map((e) => `<tr>
            <td>${escHTML(e.date)}</td>
            <td>${escHTML(labelOf(vendors, e))}</td>
            <td>$${fmtMoney(e.amountUSD, 2)}</td>
            <td>${escHTML(e.note || "")}</td>
            <td>
              <button class="btn btn-secondary" data-edit="${escHTML(e.id)}">Edit</button>
              <button class="btn btn-secondary" data-del="${escHTML(e.id)}">Delete</button>
            </td>
          </tr>`).join("") +
        "</tbody></table>";
    }
  }

  const chartWrap = document.getElementById("spendChart");
  if (chartWrap) {
    const agg = aggregateSpend(entries);
    const months = Object.keys(agg.byMonth).sort();
    if (months.length === 0) {
      chartWrap.innerHTML = '<div class="notice">No spend data.</div>';
    } else {
      chartWrap.innerHTML =
        `<div class="settings-summary" style="grid-template-columns: auto auto; justify-content: start; gap: 6px 12px; margin-bottom:12px;">` +
        `<div class="settings-kv"><span>Total spent</span><b>$${fmtMoney(summary.total, 2)}</b></div>` +
        `<div class="settings-kv"><span>Last 12 months</span><b>$${fmtMoney(summary.last12, 2)}</b></div>` +
        `<div class="settings-kv"><span>Entries</span><b>${summary.count}</b></div>` +
        `</div>` +
        "<table class=\"db-table\"><thead><tr><th>Month</th><th>Spent (USD)</th></tr></thead><tbody>" +
        months.map((m) => `<tr><td>${escHTML(m)}</td><td>$${fmtMoney(agg.byMonth[m], 2)}</td></tr>`).join("") +
        "</tbody></table>";
    }
  }

  updateSpendDateLabel();
  const addBtn = document.getElementById("spendAdd");
  if (addBtn) addBtn.textContent = editingId ? "Update" : "Add";

  wireStaticPickers();
  wireEvents(ctx);
}

function wireStaticPickers() {
  const dateTrigger = document.getElementById("spendDateTrigger");
  if (dateTrigger && !dateTrigger.dataset.bound) {
    dateTrigger.dataset.bound = "1";
    dateTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const popup = document.getElementById("spendDatePopup");
      if (popup && !popup.hidden) closeSpendDatePicker();
      else openSpendDatePicker();
    });
    const prevBtn = document.getElementById("spendDatePrev");
    const nextBtn = document.getElementById("spendDateNext");
    if (prevBtn) prevBtn.addEventListener("click", () => { shiftViewMonth(spendDateState, -1); renderSpendDateCalendar(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { shiftViewMonth(spendDateState, 1); renderSpendDateCalendar(); });
    document.addEventListener("click", (e) => {
      const popup = document.getElementById("spendDatePopup");
      if (!popup || popup.hidden) return;
      if (!e.target.closest("#spendDateTrigger") && !e.target.closest("#spendDatePopup")) {
        closeSpendDatePicker();
      }
    });
  }
}

function wireEvents(ctx) {
  const addBtn = document.getElementById("spendAdd");
  if (addBtn) addBtn.onclick = () => onAddOrUpdate(ctx);

  const tableWrap = document.getElementById("spendTable");
  if (tableWrap) tableWrap.onclick = (ev) => onTableClick(ctx, ev);

  const clearBtn = document.getElementById("spendClearAll");
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!confirm("Delete all spend entries?")) return;
      editingId = null;
      ctx.settings.spendEntries = [];
      await saveSpendEntries([]);
      resetSpendForm();
      await ctx.reload();
      renderSpend(ctx);
    };
  }
}

async function onAddOrUpdate(ctx) {
  const vendors = vendorsOf(ctx);
  const platform = document.getElementById("spendPlatform").value;
  const date = document.getElementById("spendDate").value;
  const amount = document.getElementById("spendAmount").value;
  const note = document.getElementById("spendNote").value;
  const label = platform === "other"
    ? "Other"
    : (vendors.find((v) => v.source === platform) || {}).label || platform;

  const entry = normalizeSpendEntry(
    { id: editingId || undefined, platform, platformLabel: label, date, amountUSD: amount, note },
    { now: () => new Date() }
  );
  const v = validateSpendEntry(entry);
  if (!v.ok) { alert(`Invalid spend entry: ${v.reason}`); return; }

  const next = [...(ctx.settings.spendEntries || [])];
  if (editingId) {
    const idx = next.findIndex((e) => e.id === editingId);
    if (idx >= 0) next[idx] = entry;
    else next.push(entry);
    editingId = null;
  } else {
    next.push(entry);
  }
  ctx.settings.spendEntries = next;
  await saveSpendEntries(next);
  resetSpendForm();
  await ctx.reload();
  renderSpend(ctx);
}

async function onTableClick(ctx, ev) {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  const editId = t.getAttribute("data-edit");
  const delId = t.getAttribute("data-del");
  if (delId) {
    if (editingId === delId) editingId = null;
    const next = (ctx.settings.spendEntries || []).filter((e) => e.id !== delId);
    ctx.settings.spendEntries = next;
    await saveSpendEntries(next);
    await ctx.reload();
    renderSpend(ctx);
  } else if (editId) {
    const e = (ctx.settings.spendEntries || []).find((x) => x.id === editId);
    if (!e) return;
    editingId = editId;
    document.getElementById("spendPlatform").value = e.platform;
    ensurePlatformSelect().refresh();
    document.getElementById("spendDate").value = e.date;
    spendDateState.date = e.date;
    spendDateState.viewYear = null;
    spendDateState.viewMonth = null;
    updateSpendDateLabel();
    document.getElementById("spendAmount").value = String(e.amountUSD);
    document.getElementById("spendNote").value = e.note || "";
    const addBtn = document.getElementById("spendAdd");
    if (addBtn) addBtn.textContent = "Update";
  }
}
