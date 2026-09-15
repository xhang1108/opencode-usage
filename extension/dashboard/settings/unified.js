// extension/dashboard/settings/unified.js
// Pricing tab: the single user-authored price list. Models that appear in the
// data (plus every fallback-preset model) are shown as draggable chips; drop
// chips into a group to share that group's rate table. A model in no group is
// unpriced. Groups hold the same rate-version schema as the fallback presets.

import { normalizeUnifiedPricing, validateUnifiedPricing, makeGroupId, FINGERPRINT_PREFIX, groupIdForKey } from "../../shared/unified.js";
import { validateRates } from "../../shared/pricing.js";
import { saveUnifiedPricing, loadUnifiedPreset } from "./store.js";
import { escHTML } from "../views/format.js";

const ZERO_RATES = [{ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }];

// All keys that should be pickable: every model that appears in the loaded
// records, plus every fallback-preset model (so authors can pre-assign).
function collectKeys(ctx) {
  const keys = new Set();
  for (const rec of ctx.allRecords || ctx.records || []) keys.add(`${rec.source || "opencode"}:${rec.model}`);
  for (const key of Object.keys((ctx.pricing && ctx.pricing.modelMap) || {})) keys.add(key);
  for (const key of Object.keys((ctx.settings.unifiedPricing && ctx.settings.unifiedPricing.assign) || {})) keys.add(key);
  for (const key of [...keys]) if (key.startsWith(FINGERPRINT_PREFIX)) keys.delete(key);
  return [...keys].sort();
}

async function persist(ctx, unified) {
  ctx.settings.unifiedPricing = normalizeUnifiedPricing(unified);
  await saveUnifiedPricing(ctx.settings.unifiedPricing);
  await ctx.reload();
}

// The group a chip actually prices against: an exact assign key, or - like
// priceUnified - the fingerprint fallback (shared/unified.js). Without this the
// board would list a structurally-priced model
// (commandcode:poolside/laguna-s-2.1-free) as Unassigned while its records are
// already billed at the group rate.
function effectiveGroup(unified, key) {
  return groupIdForKey(unified.assign, key);
}

function chip(key, byStructure) {
  const title = byStructure
    ? `${key} — priced by structure (fingerprint); delete the group to unpin it`
    : key;
  return `<span class="up-chip${byStructure ? " up-chip-struct" : ""}" draggable="true" data-key="${escHTML(key)}" title="${escHTML(title)}">${escHTML(key)}</span>`;
}

function groupCard(ctx, group, assignedKeys, structuralKeys) {
  const versions = Array.isArray(group.rates) ? group.rates.length : 0;
  return `
    <div class="up-group" data-drop="${escHTML(group.id)}">
      <div class="up-group-head">
        <input type="text" class="input up-group-name" data-group="${escHTML(group.id)}" value="${escHTML(group.id)}" title="Group name (rename to merge/edit)" spellcheck="false">
        <span class="up-group-count">${assignedKeys.length} model${assignedKeys.length === 1 ? "" : "s"}</span>
        <button type="button" class="btn btn-danger up-group-del" data-group="${escHTML(group.id)}" title="Delete this group (its models become unpriced)">Delete</button>
      </div>
      <div class="up-group-models">
        ${assignedKeys.map((k) => chip(k, structuralKeys.has(k))).join("") || '<span class="up-empty">Drop models here — drag a chip back to Unassigned to remove it.</span>'}
      </div>
      <details class="up-group-rates">
        <summary>Rates · ${versions} version${versions === 1 ? "" : "s"}</summary>
        <textarea class="rates-json up-group-json" spellcheck="false" data-group="${escHTML(group.id)}">${escHTML(JSON.stringify(group.rates, null, 2))}</textarea>
        <div class="rates-error" data-error="${escHTML(group.id)}" hidden></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary up-group-save" data-group="${escHTML(group.id)}">Save rates</button>
        </div>
      </details>
    </div>`;
}

export function renderUnified(ctx) {
  const wrap = document.getElementById("pricingBoard");
  if (!wrap) return;
  const unified = ctx.settings.unifiedPricing;
  const keys = collectKeys(ctx);
  const groupOf = new Map(keys.map((k) => [k, effectiveGroup(unified, k)]));
  const known = new Set(unified.groups.map((g) => g.id));
  const unassigned = keys.filter((k) => !known.has(groupOf.get(k)));
  // Chips with no explicit assign key that still resolve by fingerprint; shown in
  // the group but marked so the pin is visible.
  const structural = new Set(keys.filter((k) => groupOf.get(k) && !unified.assign[k]));

  const board = `
    <p class="modal-hint">Unified pricing: one price list for every vendor, keyed by <code>source:model</code>. Drag models into a group; models in the same group share its rate table (same <code>from</code>-dated versions, peak/off-peak windows and tiers as the fallback prices). A model in no group is <strong>unpriced</strong>.</p>
    <details class="up-json-details">
      <summary>Paste / copy the whole price list as JSON</summary>
      <p class="modal-hint" style="margin:8px 0;">Paste a <code>{ enabled, groups, assign }</code> object and press Apply — the board re-arranges to match.</p>
      <div class="rates-error" id="upJsonError" hidden></div>
      <textarea id="upJson" class="rates-json" spellcheck="false" style="min-height:220px;"></textarea>
      <div class="modal-actions" style="justify-content:flex-start;">
        <button type="button" class="btn btn-primary" id="upJsonApply">Apply JSON</button>
        <button type="button" class="btn btn-secondary" id="upJsonCopy">Copy JSON</button>
      </div>
    </details>
    <div class="up-sticky">
      <div class="settings-section-title" style="margin-top:0;">Unassigned <span class="up-group-count">${unassigned.length}</span></div>
      <div class="up-unassigned" data-drop="none">
        ${unassigned.map((k) => chip(k, false)).join("") || '<span class="up-empty">Every known model is assigned.</span>'}
      </div>
      <div class="modal-actions" style="justify-content:flex-start; margin-top:8px;">
        <button type="button" class="btn btn-secondary" id="upAddGroup">+ Add group</button>
        <button type="button" class="btn btn-secondary" id="upResetPreset">Reset to preset</button>
      </div>
    </div>
    <div class="settings-section-title">Groups</div>
    <div id="upGroups">
      ${unified.groups.map((g) => groupCard(ctx, g, keys.filter((k) => groupOf.get(k) === g.id), structural)).join("") || '<div class="notice">No groups yet. Add one, paste its rates, then drag models in.</div>'}
    </div>`;

  // When unified pricing is off the whole board is inert (greyed, not clickable)
  // with a prompt to turn it on.
  wrap.innerHTML =
    (unified.enabled
      ? ""
      : `<div class="up-off-bar">
           <span>Unified pricing is <strong>off</strong> — vendors use their own reported spend / fallback prices. Turn it on to edit this list.</span>
           <button type="button" class="btn btn-primary" id="upEnable">Enable unified pricing</button>
         </div>`) +
    `<div class="up-board${unified.enabled ? "" : " up-locked"}"${unified.enabled ? "" : " inert"}>${board}</div>`;

  if (unified.enabled) {
    wireDrag(ctx, wrap);
    wireGroupEditors(ctx, wrap);
    wireToolbar(ctx, wrap);
    wireJson(ctx, wrap);
  } else {
    const btn = wrap.querySelector("#upEnable");
    if (btn) {
      btn.addEventListener("click", async () => {
        await persist(ctx, { ...unified, enabled: true });
      });
    }
  }
}

function wireJson(ctx, wrap) {
  const ta = wrap.querySelector("#upJson");
  const err = wrap.querySelector("#upJsonError");
  if (ta) ta.value = JSON.stringify(ctx.settings.unifiedPricing, null, 2);

  function showError(msg) {
    if (!err) return;
    err.hidden = !msg;
    err.textContent = msg || "";
    if (ta) ta.classList.toggle("invalid", !!msg);
  }

  const apply = wrap.querySelector("#upJsonApply");
  if (apply && ta) {
    apply.addEventListener("click", async () => {
      let parsed;
      try {
        parsed = JSON.parse(ta.value || "{}");
      } catch (e) {
        showError(e.message || String(e));
        return;
      }
      const errors = validateUnifiedPricing(parsed);
      if (errors.length > 0) {
        showError(errors.join("\n"));
        return;
      }
      showError("");
      await persist(ctx, parsed);
    });
  }

  const copy = wrap.querySelector("#upJsonCopy");
  if (copy && ta) {
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(ta.value);
        copy.textContent = "Copied!";
        setTimeout(() => (copy.textContent = "Copy JSON"), 1200);
      } catch (e) {
        showError("Copy failed: " + (e && e.message ? e.message : String(e)));
      }
    });
  }
}

function wireDrag(ctx, wrap) {
  for (const el of wrap.querySelectorAll(".up-chip")) {
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", el.dataset.key);
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  }
  for (const zone of wrap.querySelectorAll("[data-drop]")) {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drop-hot");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-hot"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("drop-hot");
      const key = e.dataTransfer.getData("text/plain");
      if (!key) return;
      const target = zone.dataset.drop;
      const unified = normalizeUnifiedPricing(ctx.settings.unifiedPricing);
      if (target === "none") delete unified.assign[key];
      else unified.assign[key] = target;
      await persist(ctx, unified);
    });
  }
}

function wireGroupEditors(ctx, wrap) {
  for (const btn of wrap.querySelectorAll(".up-group-save")) {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.group;
      const ta = wrap.querySelector(`textarea[data-group="${CSS.escape(id)}"]`);
      const errEl = wrap.querySelector(`[data-error="${CSS.escape(id)}"]`);
      let rates;
      try {
        rates = JSON.parse(ta.value || "[]");
      } catch (e) {
        errEl.textContent = e.message || String(e);
        errEl.hidden = false;
        return;
      }
      const errors = validateRates([{ model: id, rates }]);
      if (errors.length > 0) {
        errEl.textContent = errors.join("\n");
        errEl.hidden = false;
        return;
      }
      errEl.hidden = true;
      const unified = normalizeUnifiedPricing(ctx.settings.unifiedPricing);
      const group = unified.groups.find((g) => g.id === id);
      if (group) group.rates = rates;
      await persist(ctx, unified);
    });
  }
  for (const btn of wrap.querySelectorAll(".up-group-del")) {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.group;
      if (!confirm(`Delete group "${id}"? Its models become unpriced.`)) return;
      const unified = normalizeUnifiedPricing(ctx.settings.unifiedPricing);
      unified.groups = unified.groups.filter((g) => g.id !== id);
      await persist(ctx, unified);
    });
  }
  for (const input of wrap.querySelectorAll(".up-group-name")) {
    input.addEventListener("change", async () => {
      const oldId = input.dataset.group;
      const newId = input.value.trim();
      if (!newId || newId === oldId) {
        input.value = oldId;
        return;
      }
      const unified = normalizeUnifiedPricing(ctx.settings.unifiedPricing);
      if (unified.groups.some((g) => g.id === newId)) {
        alert(`A group named "${newId}" already exists.`);
        input.value = oldId;
        return;
      }
      // Rename the group and re-point every assignment so nothing dangles.
      unified.groups = unified.groups.map((g) => (g.id === oldId ? { ...g, id: newId } : g));
      const assign = {};
      for (const [key, groupId] of Object.entries(unified.assign)) assign[key] = groupId === oldId ? newId : groupId;
      unified.assign = assign;
      await persist(ctx, unified);
    });
  }
}

function wireToolbar(ctx, wrap) {
  const add = wrap.querySelector("#upAddGroup");
  if (add) {
    add.addEventListener("click", async () => {
      const unified = normalizeUnifiedPricing(ctx.settings.unifiedPricing);
      const used = new Set(unified.groups.map((g) => g.id));
      unified.groups.push({ id: makeGroupId(used), rates: ZERO_RATES });
      await persist(ctx, unified);
    });
  }
  const reset = wrap.querySelector("#upResetPreset");
  if (reset) {
    reset.addEventListener("click", async () => {
      if (!confirm("Replace the whole price list with the shipped preset?")) return;
      const preset = await loadUnifiedPreset();
      preset.enabled = ctx.settings.unifiedPricing.enabled;
      await persist(ctx, preset);
    });
  }
}
