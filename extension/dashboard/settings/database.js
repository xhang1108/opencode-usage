// extension/dashboard/settings/database.js
// Settings → Database: every usage store, where it lives, and what can be
// deleted. Stores are collapsed by default (expensive tables are built lazily
// on expand). OPFS crawl data is owned by the opencode content script and shown
// read-only; chrome.storage.local stores support per-record and full delete.

import { escHTML } from "../views/format.js";
import { clearMessageFor } from "../../shared/stores.js";

const RENDER_LIMIT = 500;

export async function renderDatabase(ctx) {
  const wrap = document.getElementById("databaseStores");
  if (!wrap) return;
  wrap.innerHTML = '<div class="notice">Loading data stores…</div>';

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "get-database" });
  } catch (e) {
    wrap.innerHTML = `<div class="notice">Could not read stores: ${escHTML((e && e.message) || String(e))}</div>`;
    return;
  }
  if (!res || !res.ok) {
    wrap.innerHTML = `<div class="notice">Could not read stores: ${escHTML((res && res.error) || "unknown")}</div>`;
    return;
  }

  wrap.innerHTML = "";
  const intro = document.createElement("p");
  intro.className = "modal-hint";
  intro.innerHTML =
    "Every usage store the extension knows about. Click a store to expand it. Records in <code>chrome.storage.local</code> can be deleted here; " +
    "<strong>OPFS</strong> crawl data is managed by the opencode page crawler.";
  wrap.appendChild(intro);

  for (const store of res.stores) wrap.appendChild(renderStore(ctx, store));
}

function renderStore(ctx, store) {
  const details = document.createElement("details");
  details.className = "db-store";

  const summary = document.createElement("summary");
  summary.className = "db-store-head";
  summary.innerHTML = `
    <div class="db-store-title">
      <strong>${escHTML(store.label)}</strong>
      <span class="db-loc">${escHTML(store.location)}</span>
    </div>
    <div class="db-store-meta">
      <span class="badge">${store.count.toLocaleString()} records</span>
      <span>${store.tokens.toLocaleString()} tokens</span>
      <span class="db-caret">▸</span>
    </div>`;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "db-store-body";
  details.appendChild(body);

  let built = false;
  details.addEventListener("toggle", () => {
    if (!details.open || built) return;
    built = true;
    buildStoreBody(ctx, store, body);
  });

  return details;
}

function buildStoreBody(ctx, store, body) {
  if (!store.managed) {
    const note = document.createElement("div");
    note.className = "db-note-block";
    note.innerHTML =
      "These records live in <strong>OPFS</strong> on the <code>opencode.ai</code> origin (owned by the page crawler). " +
      "The extension reads them but does not store or delete them here.";
    body.appendChild(note);
  } else {
    const toolbar = document.createElement("div");
    toolbar.className = "db-store-toolbar";
    toolbar.innerHTML = `<button type="button" class="btn btn-danger" data-clear-all>Delete all ${store.count.toLocaleString()}</button>`;
    toolbar.querySelector("[data-clear-all]").addEventListener("click", async () => {
      if (!confirm(`Delete all ${store.count} ${store.label} record(s)?`)) return;
      const msg = clearMessageFor(store.key);
      if (!msg) return;
      let r = null;
      try {
        r = await chrome.runtime.sendMessage(msg);
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      if (!r || !r.ok) {
        alert("Delete failed: " + ((r && r.error) || "unknown"));
        return;
      }
      await ctx.refreshData();
    });
    body.appendChild(toolbar);
  }

  if (store.count === 0) {
    const empty = document.createElement("div");
    empty.className = "db-note-block";
    empty.textContent = "No records.";
    body.appendChild(empty);
    return;
  }

  const shown = store.rows.slice(0, RENDER_LIMIT);
  const table = document.createElement("table");
  table.className = "db-table";
  table.innerHTML =
    `<thead><tr><th>Model</th><th>Source</th><th>Time</th><th>Input</th><th>Output</th><th>Cache read</th>${
      store.managed ? "<th></th>" : ""
    }</tr></thead>` +
    "<tbody>" +
    shown
      .map(
        (r) => `<tr>
          <td><strong>${escHTML(r.model)}</strong></td>
          <td>${escHTML(r.source)}</td>
          <td class="db-time">${escHTML(r.time)}</td>
          <td>${r.input.toLocaleString()}</td>
          <td>${r.output.toLocaleString()}</td>
          <td>${r.cacheRead.toLocaleString()}</td>
          ${store.managed ? `<td><button type="button" class="row-del" data-del="${escHTML(r.id)}" title="Delete this record">×</button></td>` : ""}
        </tr>`
      )
      .join("") +
    "</tbody>";
  body.appendChild(table);

  if (store.count > shown.length) {
    const trunc = document.createElement("div");
    trunc.className = "db-note-block";
    trunc.textContent = `Showing ${shown.length} of ${store.count.toLocaleString()} records.`;
    body.appendChild(trunc);
  }

  if (!store.managed) return;

  table.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm(`Delete record ${id}?`)) return;
      let r = null;
      try {
        r = await chrome.runtime.sendMessage({ type: "remove-records", source: store.source, ids: [id] });
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      if (!r || !r.ok) {
        alert("Delete failed: " + ((r && r.error) || "unknown"));
        return;
      }
      if (r.removed === 0) {
        alert("That record is crawler-owned and cannot be deleted here.");
        return;
      }
      await ctx.refreshData();
    });
  });
}
