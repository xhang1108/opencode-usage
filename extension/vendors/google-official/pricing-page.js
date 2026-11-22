// extension/vendors/google-official/pricing-page.js
// Parse Google's official Gemini 4 Developer API pricing page (the Liquid-flavoured
// markdown served at https://ai.google.dev/gemini-api/docs/pricing). Pure (P9).
//
// Scope: the four Gemini 4 text models only (argon, carbon, neon, hydrogen).
// Only the "Standard" tab is read — Batch/Flex/Priority are serving-mode
// discounts and must never leak into the rate table; Contributor is invite-only.
//
// All four models state "Implicit caching only (explicit caching is not
// supported)", so cacheWrite is always 0. Prices are USD per 1M tokens: no
// multiplier, no FX — the published number is the number we store.
//
// Carbon and Argon publish a scheduled change inside one cell ("$2.00 through
// November 30, 2026" / "$4.00 starting December 1, 2026"). A snapshot model may
// carry `versions` (a full dated chain); price-history.js replays it verbatim,
// so the future rate is already in the preset before the change takes effect.
// `entry` is still emitted (the current leg) for older readers and integrity
// checks.

export const GOOGLE_SOURCE = "google-official";

const MODEL_IDS = ["gemini-4-carbon", "gemini-4-argon", "gemini-4-neon", "gemini-4-hydrogen"];
const MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function isoDate(text) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(text || "").trim());
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${String(m[2]).padStart(2, "0")}T00:00:00Z`;
}

// A cell can hold one price, or a "through DATE" price plus a "starting DATE"
// price. Parse both without assuming an amount's position in the cell.
function amounts(cell) {
  const out = [];
  // Each amount owns the text up to the next `$`, which is where its own
  // "through DATE" / "starting DATE" qualifier lives. Liquid table cells may be
  // one line or several, so never assume a line boundary between two prices.
  const re = /\$\s*([\d,]+(?:\.\d+)?)([^$]*)/g;
  let m;
  while ((m = re.exec(String(cell || "")))) {
    const through = /\bthrough\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i.exec(m[2]);
    const starting = /\bstarting\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i.exec(m[2]);
    out.push({
      value: Number(m[1].replace(/,/g, "")),
      through: through ? isoDate(through[1]) : null,
      starting: starting ? isoDate(starting[1]) : null,
    });
  }
  return out;
}

function sections(md) {
  const out = new Map();
  let current = null;
  for (const line of String(md).split("\n")) {
    const head = /^##\s+.*?\{%\s*id="([^"]+)"\s*%\}/.exec(line);
    if (head) {
      current = { id: head[1], lines: [] };
      out.set(current.id, current.lines);
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return out;
}

// Liquid table rows are separated by a bare `---`; a cell starts with `* ` and
// any following non-bullet lines are its continuation.
function standardTable(sectionLines, model) {
  const text = sectionLines.join("\n");
  const tab = text.indexOf('{% tab title="Standard" %}');
  if (tab === -1) throw new Error(`Google pricing: ${model} has no Standard tab`);
  const tabEnd = text.indexOf("{% /tab %}", tab);
  if (tabEnd === -1) throw new Error(`Google pricing: ${model} Standard tab is unclosed`);
  const tabText = text.slice(tab, tabEnd);
  const table = tabText.indexOf("{% table %}");
  if (table === -1) throw new Error(`Google pricing: ${model} Standard tab has no table`);
  const tableEnd = tabText.indexOf("{% /table %}", table);
  if (tableEnd === -1) throw new Error(`Google pricing: ${model} Standard table is unclosed`);
  return tabText.slice(table, tableEnd).split(/^[ \t]*---[ \t]*$/m);
}

function cellsOf(row) {
  const cells = [];
  for (const line of row.split("\n")) {
    if (/^\s*$/.test(line)) continue;
    const bullet = /^\s*\*\s+(.*)$/.exec(line);
    if (bullet) cells.push([bullet[1].trim()]);
    else if (cells.length) cells[cells.length - 1].push(line.trim());
  }
  return cells.map((c) => c.join(" "));
}

const FEATURES = {
  "input price": "input",
  "output price": "output",
  "context caching price": "cacheRead",
};
function featureOf(cell) {
  const name = String(cell || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (FEATURES[name]) return FEATURES[name];
  for (const [prefix, role] of Object.entries(FEATURES)) if (name.startsWith(prefix)) return role;
  return null;
}

// md -> { "<id>": { label, entry, versions } }
export function parseStandardTable(md) {
  const sectionsByModel = sections(md);
  const out = {};
  for (const model of MODEL_IDS) {
    const lines = sectionsByModel.get(model);
    if (!lines) throw new Error(`Google pricing: ${model} section missing`);
    const paid = {};
    for (const row of standardTable(lines, model)) {
      const cells = cellsOf(row);
      const role = featureOf(cells[0]);
      if (!role || cells.length < 3) continue;
      if (paid[role]) throw new Error(`Google pricing: duplicate ${role} row for ${model}`);
      const list = amounts(cells[2]);
      if (list.length === 0) throw new Error(`Google pricing: ${model} ${role} has no price`);
      if (list.length > 2) throw new Error(`Google pricing: ${model} ${role} has ${list.length} prices`);
      paid[role] = list;
    }
    for (const role of ["input", "output", "cacheRead"]) {
      if (!paid[role]) throw new Error(`Google pricing: ${model} ${role} row missing`);
    }

    const futureDates = new Set();
    for (const role of ["input", "output", "cacheRead"]) {
      const list = paid[role];
      if (list.length === 2) {
        if (!list[0].through || !list[1].starting) throw new Error(`Google pricing: ${model} ${role} schedule incomplete`);
        futureDates.add(list[1].starting);
      } else if (list[0].starting) {
        futureDates.add(list[0].starting);
      }
    }
    if (futureDates.size > 1) throw new Error(`Google pricing: ${model} has conflicting scheduled dates`);
    const future = futureDates.size ? [...futureDates][0] : null;
    if (future && ["input", "output", "cacheRead"].some((role) => paid[role].length !== 2)) {
      throw new Error(
        `Google pricing: ${model} scheduled change is incomplete: ` +
          ["input", "output", "cacheRead"].map((role) => `${role}=${paid[role].length}`).join(", "),
      );
    }

    const flatOf = (i) => ({
      input: paid.input[i].value,
      output: paid.output[i].value,
      cacheRead: paid.cacheRead[i].value,
      cacheWrite: 0,
    });
    const current = flatOf(0);
    if (!(current.input > 0 && current.output >= current.input && current.cacheRead <= current.input)) {
      throw new Error(`Google pricing: insane prices for ${model}`);
    }
    const versions = [{ from: null, pricing: { flat: current } }];
    if (future) {
      const next = flatOf(1);
      if (!(next.input > 0 && next.output >= next.input && next.cacheRead <= next.input)) {
        throw new Error(`Google pricing: insane scheduled prices for ${model}`);
      }
      versions.push({ from: future, pricing: { flat: next } });
    }
    out[model] = { label: model, entry: { pricing: versions[0].pricing }, versions };
  }
  return out;
}

export function snapshotFromPage(md, capturedAt, { source = GOOGLE_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parseStandardTable(md) };
}
