import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchCached } from "../vendor/fluidaudio-web/core/modelCache.js";

test("accepts an exact model hash and size", async () => {
  const bytes = new TextEncoder().encode("verified model");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const previous = { caches: globalThis.caches, fetch: globalThis.fetch };
  globalThis.caches = { open: async () => ({ match: async () => null, put: async () => undefined }) };
  globalThis.fetch = async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  try {
    assert.deepEqual(
      await fetchCached("https://example.test/model", undefined, "model", { expectedBytes: bytes.length, expectedSha256: sha256 }),
      bytes
    );
  } finally {
    restoreGlobals(previous);
  }
});

test("rejects a hash mismatch", async () => {
  const bytes = new TextEncoder().encode("corrupt model");
  const previous = { caches: globalThis.caches, fetch: globalThis.fetch };
  globalThis.caches = { open: async () => ({ match: async () => null, put: async () => undefined }) };
  globalThis.fetch = async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  try {
    await assert.rejects(
      fetchCached("https://example.test/model", undefined, "model", { expectedBytes: bytes.length, expectedSha256: "0".repeat(64) }),
      /model_hash_mismatch/
    );
  } finally {
    restoreGlobals(previous);
  }
});

test("replaces a corrupt cached model with verified bytes", async () => {
  const good = new TextEncoder().encode("verified replacement");
  const bad = new TextEncoder().encode("corrupt cache");
  const sha256 = createHash("sha256").update(good).digest("hex");
  let deleted = false;
  let stored = false;
  const previous = { caches: globalThis.caches, fetch: globalThis.fetch };
  globalThis.caches = {
    open: async () => ({
      match: async () => new Response(bad),
      delete: async () => { deleted = true; },
      put: async () => { stored = true; }
    })
  };
  globalThis.fetch = async () => new Response(good, { headers: { "content-length": String(good.length) } });
  try {
    assert.deepEqual(
      await fetchCached("https://example.test/model", undefined, "model", { expectedBytes: good.length, expectedSha256: sha256 }),
      good
    );
    assert.equal(deleted, true);
    assert.equal(stored, true);
  } finally {
    restoreGlobals(previous);
  }
});

test("rejects interrupted and missing downloads without caching them", async () => {
  const previous = { caches: globalThis.caches, fetch: globalThis.fetch };
  let stored = false;
  globalThis.caches = { open: async () => ({ match: async () => null, put: async () => { stored = true; } }) };
  try {
    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(fetchCached("https://example.test/missing"), /404/);
    assert.equal(stored, false);

    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers({ "content-length": "8" }),
      body: { getReader: () => ({ read: async () => { throw new Error("connection reset"); } }) }
    });
    await assert.rejects(fetchCached("https://example.test/interrupted"), /connection reset/);
    assert.equal(stored, false);
  } finally {
    restoreGlobals(previous);
  }
});

function restoreGlobals(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
