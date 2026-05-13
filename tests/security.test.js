// Security boundary tests — public 前の最低限カバレッジ。
// CORS allowlist / OAuth scope / XSS escape / cache 分離。
//
// node --test で実行、Cloudflare Worker は素の ES module として import 可能。

import test from "node:test";
import assert from "node:assert/strict";
import { corsHeaders, isOriginAllowed } from "../worker/index.js";
import { scopeFor } from "../public/js/auth.js";
import { escapeHtml } from "../public/js/util.js";

// ── corsHeaders ────────────────────────────────────────────────
test("corsHeaders: matched origin → ACAO=origin", () => {
  const h = corsHeaders("https://yuujikamura.github.io",
                        "https://yuujikamura.github.io");
  assert.equal(h["Access-Control-Allow-Origin"], "https://yuujikamura.github.io");
  assert.equal(h.Vary, "Origin");
});

test("corsHeaders: multi-entry allowlist matches one of them", () => {
  const h = corsHeaders("http://localhost:8765",
                        "https://x.github.io, http://localhost:8765");
  assert.equal(h["Access-Control-Allow-Origin"], "http://localhost:8765");
});

test("corsHeaders: unmatched origin → no ACAO header (fail-closed)", () => {
  const h = corsHeaders("https://evil.example.com",
                        "https://yuujikamura.github.io");
  assert.equal(h["Access-Control-Allow-Origin"], undefined);
});

test("corsHeaders: empty allowlist → no ACAO header (fail-closed)", () => {
  const h = corsHeaders("https://yuujikamura.github.io", "");
  assert.equal(h["Access-Control-Allow-Origin"], undefined);
});

test("corsHeaders: empty allowlist AND empty origin → no ACAO (fail-closed)", () => {
  const h = corsHeaders("", "");
  assert.equal(h["Access-Control-Allow-Origin"], undefined);
});

// ── isOriginAllowed ────────────────────────────────────────────
test("isOriginAllowed: match → true", () => {
  assert.equal(isOriginAllowed("https://a.example", "https://a.example"), true);
});

test("isOriginAllowed: no match → false", () => {
  assert.equal(isOriginAllowed("https://evil", "https://a.example"), false);
});

test("isOriginAllowed: empty allowlist → false", () => {
  assert.equal(isOriginAllowed("https://a.example", ""), false);
});

test("isOriginAllowed: empty origin → false (even with allowlist)", () => {
  assert.equal(isOriginAllowed("", "https://a.example"), false);
});

// ── scopeFor (OAuth scope min privilege) ──────────────────────
test("scopeFor: default (no scopeReadAll) → activity:read", () => {
  assert.equal(scopeFor({ clientId: "1", workerUrl: "x" }), "activity:read");
});

test("scopeFor: scopeReadAll=true → activity:read_all", () => {
  assert.equal(scopeFor({ scopeReadAll: true }), "activity:read_all");
});

test("scopeFor: null/undefined cfg → activity:read (fail-safe)", () => {
  assert.equal(scopeFor(null), "activity:read");
  assert.equal(scopeFor(undefined), "activity:read");
});

// ── escapeHtml (XSS) ──────────────────────────────────────────
test("escapeHtml: 5 entities + identity", () => {
  assert.equal(escapeHtml(`<script>alert("x&y")</script>`),
               "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("'"), "&#39;");
  assert.equal(escapeHtml("plain text"), "plain text");
});

test("escapeHtml: non-string coerces via String()", () => {
  assert.equal(escapeHtml(123), "123");
  assert.equal(escapeHtml(null), "null");
});

// ── cache.clearAllForAthlete (privacy: 他 athlete 巻き込み禁止) ─
test("cache.clearAllForAthlete: 他 athlete のキーを消さない", async () => {
  // localStorage stub
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; },
    key(i)        { return [...mem.keys()][i] ?? null; },
    getItem(k)    { return mem.has(k) ? mem.get(k) : null; },
    setItem(k, v) { mem.set(k, String(v)); },
    removeItem(k) { mem.delete(k); },
    clear()       { mem.clear(); },
  };
  const cache = await import("../public/js/cache.js");
  cache.saveYearCache(111, 2024, [{ id: 1 }]);
  cache.saveYearCache(111, 2025, [{ id: 2 }]);
  cache.saveYearCache(222, 2025, [{ id: 3 }]);  // 他 athlete
  cache.clearAllForAthlete(111);
  assert.equal(cache.loadYearCache(111, 2024), null);
  assert.equal(cache.loadYearCache(111, 2025), null);
  assert.ok(cache.loadYearCache(222, 2025), "他 athlete のキャッシュは生存");
  delete globalThis.localStorage;
});
