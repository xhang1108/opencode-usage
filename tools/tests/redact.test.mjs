import { test } from "node:test";
import assert from "node:assert/strict";

import { redactSecrets, DEFAULT_SECRET_KEYS } from "../../extension/shared/redact.js";

test("redactSecrets drops credentials but keeps api_key_name and token counts", () => {
  const row = {
    model: "deepseek-v4-pro",
    api_key_name: "For zed",
    api_key: "sk-c4da5***b0e2",
    type: "output_tokens",
    amount: 247855,
    tokensIn: "1462",
    meta: { traceId: "x", authorization: "Bearer abc", access_token: "t" },
  };
  const out = redactSecrets(row);
  assert.equal(out.api_key, undefined);
  assert.equal(out.meta.authorization, undefined);
  assert.equal(out.meta.access_token, undefined);
  assert.equal(out.api_key_name, "For zed");
  assert.equal(out.tokensIn, "1462");
  assert.equal(out.meta.traceId, "x");
  assert.equal(out.model, "deepseek-v4-pro");
});

test("redactSecrets is case-insensitive on known keys", () => {
  const out = redactSecrets({ API_KEY: "x", ApiKey: "y", Cookie: "z", output: 1 });
  assert.deepEqual(out, { output: 1 });
});

test("redactSecrets does not mutate the input", () => {
  const row = { api_key: "x", keep: 1 };
  redactSecrets(row);
  assert.equal(row.api_key, "x");
});

test("redactSecrets supports extra patterns", () => {
  const out = redactSecrets({ user_secret_blob: "x", fine: 2 }, { patterns: [/secret_blob$/] });
  assert.deepEqual(out, { fine: 2 });
  assert.ok(DEFAULT_SECRET_KEYS.includes("api_key"));
});
