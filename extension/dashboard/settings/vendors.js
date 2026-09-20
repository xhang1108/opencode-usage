// extension/dashboard/settings/vendors.js
// Vendors tab: per-vendor enable (D9) and crawl controls. When unified pricing
// is on (its master switch lives on the Pricing tab), every vendor's own cost
// basis (reported spend / fallback price tables) is bypassed and greyed out.

import { saveVendorSettings, saveAutoSync } from "./store.js";
import { escHTML } from "../views/format.js";
import { vendorMeta, hasOrigins } from "./vendors-model.js";

export function renderVendors(ctx) {
  const wrap = document.getElementById("vendorsList");
  const vendors = (ctx.settings.registry && ctx.settings.registry.vendors) || [];
  wrap.innerHTML = "";

  if (vendors.length === 0) {
    const note = document.createElement("div");
    note.className = "notice";
    note.textContent = "Vendor registry not loaded yet. Reload the extension.";
    wrap.appendChild(note);
    return;
  }

  const unifiedOn = ctx.settings.unifiedPricing.enabled;
  for (const v of vendors) {
    const enabled = ctx.isEnabled(v.source);
    const hasPreset = ctx.presetSources ? ctx.presetSources.has(v.source) : true;
    const { modes, basis } = vendorMeta(v, { unifiedOn, hasPreset });

    const row = document.createElement("div");
    row.className = "settings-vendor" + (enabled ? "" : " disabled");
    row.innerHTML = `
      <div class="settings-vendor-main">
        <label class="switch" title="${enabled ? "Disable" : "Enable"}">
          <input type="checkbox" data-enable="${escHTML(v.source)}" ${enabled ? "checked" : ""}>
          <span class="track"></span>
        </label>
        <div class="settings-vendor-text">
          <strong>${escHTML(v.label || v.source)}</strong>
          <span class="settings-vendor-meta${unifiedOn ? " up-muted" : ""}">${escHTML(modes)} · ${escHTML(basis)}</span>
        </div>
      </div>
      <div class="settings-vendor-actions">
        ${v.crawl ? `<button type="button" class="btn btn-secondary settings-crawl" data-crawl="${escHTML(v.source)}" title="Incremental sync (shift-click for a full rescan)" ${enabled ? "" : "disabled"}>${v.source === "opencode" ? "Sync now" : "Crawl now"}</button>` : ""}
        <button type="button" class="btn btn-danger settings-clear" data-clear="${escHTML(v.source)}" title="Delete all stored records for this vendor">Clear</button>
      </div>
    `;

    const crawlBtn = row.querySelector("[data-crawl]");
    if (crawlBtn) {
      crawlBtn.addEventListener("click", async (e) => {
        const full = e.shiftKey;
        if (full) {
          const note = ctx.records && ctx.records.length ? `\n\nCurrently stored: ${ctx.records.length.toLocaleString()} records.` : "";
          if (!confirm(`Full sync ALL ${v.label || v.source} history?${note}\n\nThis re-fetches the full history (more server requests, can take several minutes).`)) return;
        }
        crawlBtn.disabled = true;
        const label = crawlBtn.textContent;
        crawlBtn.textContent = "Crawling…";
        try {
          const res = await chrome.runtime.sendMessage({ type: "start-crawl", vendor: v.source, full, rescan: full });
          crawlBtn.textContent = res && res.ok ? (res.started ? "Started" : "Busy") : "Failed";
        } catch (err) {
          crawlBtn.textContent = "Failed";
        }
        setTimeout(() => {
          crawlBtn.textContent = label;
          crawlBtn.disabled = false;
        }, 2000);
      });
    }

    const clearBtn = row.querySelector("[data-clear]");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        if (!confirm(`Delete ALL stored ${v.label || v.source} records?\n\nOther vendors are not affected. Sync to fetch them again.`)) return;
        clearBtn.disabled = true;
        try {
          const res = await chrome.runtime.sendMessage({ type: "clear-vendor-data", source: v.source });
          if (!res || !res.ok) {
            alert("Clear failed: " + ((res && res.error) || "unknown"));
            clearBtn.disabled = false;
            return;
          }
          alert(`Cleared ${res.removed} ${v.label || v.source} records (${res.total} total).`);
          await ctx.refreshData();
        } catch (e) {
          alert("Clear failed: " + (e && e.message ? e.message : String(e)));
          clearBtn.disabled = false;
        }
      });
    }

    row.querySelector("[data-enable]").addEventListener("change", async (e) => {
      const wantEnabled = e.target.checked;
      // B1: a non-default vendor's origins are optional, so ask for access on the
      // enable gesture. Default vendors are already granted (request throws).
      if (wantEnabled && hasOrigins(v)) {
        let granted = true;
        try {
          granted = await chrome.permissions.request({ origins: v.origins });
        } catch (err) {
          granted = true;
        }
        if (!granted) {
          e.target.checked = false;
          alert(`${v.label || v.source} needs access to ${v.origins.join(", ")} to sync. Access was not granted.`);
          return;
        }
      }
      ctx.settings.vendorSettings = { ...ctx.settings.vendorSettings, [v.source]: wantEnabled };
      await saveVendorSettings(ctx.settings.vendorSettings);
      await chrome.runtime.sendMessage({ type: "sync-vendor-scripts" }).catch(() => {});
      await ctx.reload();
    });

    if (enabled && hasOrigins(v)) decorateOriginAccess(v, row, ctx);

    // Auto-sync is opencode-only (its Console API needs a signed-in page tab).
    // Kept in the left group so it sits with the vendor name, leaving Sync now
    // (in the right actions column) on the right.
    if (v.source === "opencode") {
      const main = row.querySelector(".settings-vendor-main");
      if (main) main.appendChild(renderAutoSync(ctx));
    }

    wrap.appendChild(row);
  }
}

// opencode-only auto-sync toggle: background reschedules its 6h alarm when the
// stored key changes (see background's storage.onChanged listener).
function renderAutoSync(ctx) {
  const on = !!ctx.settings.autoSync;
  const box = document.createElement("div");
  box.className = "settings-vendor-auto";
  box.innerHTML =
    `<label class="switch" title="Auto-sync opencode every 6 hours. Reuses an open Console tab; otherwise opens one in the background and closes it afterwards.">` +
    `<input type="checkbox" data-auto-sync ${on ? "checked" : ""}>` +
    `<span class="track"></span></label>` +
    `<span class="settings-vendor-meta">Auto-sync every 6h (opencode only)</span>`;
  box.querySelector("[data-auto-sync]").addEventListener("change", async (e) => {
    ctx.settings.autoSync = e.target.checked;
    await saveAutoSync(e.target.checked);
  });
  return box;
}

// B1: an enabled vendor whose optional origin was not granted (e.g. after an
// update moved it out of host_permissions) shows a Grant button; sync is paused
// until the user grants it.
async function decorateOriginAccess(v, row, ctx) {
  let granted = true;
  try {
    granted = await chrome.permissions.contains({ origins: v.origins });
  } catch (e) {
    granted = true;
  }
  if (granted || !row.isConnected) return;
  const crawlBtn = row.querySelector("[data-crawl]");
  if (crawlBtn) crawlBtn.disabled = true;
  const warn = document.createElement("div");
  warn.className = "settings-vendor-warn";
  warn.innerHTML =
    `Access to ${escHTML(v.origins.join(", "))} is not granted — sync is paused. ` +
    `<button type="button" class="btn btn-secondary" data-grant>Grant access</button>`;
  warn.querySelector("[data-grant]").addEventListener("click", async () => {
    let ok = false;
    try {
      ok = await chrome.permissions.request({ origins: v.origins });
    } catch (e) {
      ok = false;
    }
    if (ok) {
      await chrome.runtime.sendMessage({ type: "sync-vendor-scripts" }).catch(() => {});
      await ctx.reload();
    }
  });
  row.appendChild(warn);
}
