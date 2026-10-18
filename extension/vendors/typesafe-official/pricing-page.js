// extension/vendors/typesafe-official/pricing-page.js
// Parse TypeSafe's official Jev pricing from docs.typesafe.ai/models.md.
// Pure (P9).
//
// Layout: Markdown table under "## Current models" with columns:
// | | Jev 1.14 | Jev 1.13 |
// | Model ID | `jev-1.14.0` | `jev-1.13.0` |
// | Price (per Btok / per Mtok) | $42 / $0.042 | $42 / $0.042 |
// Output tokens are free. USD per 1M tokens — no FX needed.

export const TYPESAFE_SOURCE = "typesafe-official";

const MIN_MODELS = 1;
const ANCHOR = "jev-1.14.0";

function money(cell) {
  // Matches "$42 / $0.042" or "\$42 / \$0.042" (escaped in markdown) and returns the per-Mtok value.
  // The table shows "Price (per Btok / per Mtok)" so the second number is per-Mtok.
  const m = /\\?\$\s*([0-9.]+)\s*\/\s*\\?\$\s*([0-9.]+)/.exec(String(cell || ""));
  if (m) return Number(m[2]); // per-Mtok is the second number
  const single = /\\?\$\s*([0-9.]+)/.exec(String(cell || ""));
  return single ? Number(single[1]) : 0;
}

function modelId(raw) {
  return String(raw || "")
    .replace(/`/g, "")
    .trim();
}

// md -> { "<id>": { label, entry } }
export function parsePricingModels(md) {
  const text = String(md);
  const start = text.indexOf("## Current models");
  if (start === -1) throw new Error("TypeSafe pricing: '## Current models' section missing");
  const rest = text.slice(start);
  const endm = /\n## /.exec(rest);
  const section = endm ? rest.slice(0, endm.index) : rest;

  // Find the Price row
  const lines = section.split("\n");
  const priceRow = lines.find((l) => /Price\s*\(per Btok/.test(l));
  if (!priceRow) throw new Error("TypeSafe pricing: 'Price (per Btok / per Mtok)' row not found");

  const cells = priceRow.split("|").slice(1, -1).map((c) => c.trim());
  if (cells.length < 3) throw new Error("TypeSafe pricing: Price row has too few columns");

  // Cells: ["", "Jev 1.14", "Jev 1.13"] — we need the model IDs from the Model ID row
  const idRow = lines.find((l) => /Model ID/.test(l));
  if (!idRow) throw new Error("TypeSafe pricing: 'Model ID' row not found");
  const idCells = idRow.split("|").slice(1, -1).map((c) => modelId(c));
  if (idCells.length < 3) throw new Error("TypeSafe pricing: Model ID row has too few columns");

  const out = {};
  // idCells[0] is empty header, idCells[1] = "jev-1.14.0", idCells[2] = "jev-1.13.0"
  // cells[0] is empty header, cells[1] = "$42 / $0.042", cells[2] = "$42 / $0.042"
  for (let i = 1; i < idCells.length; i++) {
    const id = idCells[i];
    if (!id) continue;
    const price = money(cells[i]);
    if (!(price > 0)) throw new Error(`TypeSafe pricing: invalid price for ${id}`);

    // Jev: input = $0.042/Mtok, output = 0 (free), no cache pricing published
    const entry = {
      pricing: {
        flat: {
          input: price,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    };
    out[id] = { label: id, entry };
  }

  // Fail closed: empty parse / missing anchor / suspiciously few rows
  const count = Object.keys(out).length;
  if (count === 0) throw new Error("TypeSafe pricing: no model rows parsed");
  if (!out[ANCHOR]) throw new Error(`TypeSafe pricing: anchor model ${ANCHOR} missing`);
  if (count < MIN_MODELS) throw new Error(`TypeSafe pricing: only ${count} models (<${MIN_MODELS}) — layout drift?`);

  // Jev-specific sanity: input > 0, output >= 0 (free is intentional)
  for (const [id, m] of Object.entries(out)) {
    const f = m.entry.pricing.flat;
    if (!(f.input > 0 && f.output >= 0 && f.cacheRead === 0 && f.cacheWrite === 0)) {
      throw new Error(`TypeSafe pricing: unexpected prices for ${id}`);
    }
  }
  return out;
}

export function snapshotFromPage(md, capturedAt, { source = TYPESAFE_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(md) };
}