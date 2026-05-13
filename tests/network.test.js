// Network boundary tests — Strava API ToS 順守 (rate-limit backoff)。
// 429 を受けた時に Retry-After を尊重して待機 → continue する経路を検証。

import test from "node:test";
import assert from "node:assert/strict";

test("fetchActivities: 429 + Retry-After → 待機して再試行、tight loop しない", async () => {
  // fetch sequence: 429 (Retry-After: 2) → 200 (empty list) で break
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, opts) => {
    n++;
    calls.push({ n, headers: opts?.headers || {} });
    if (n === 1) {
      return {
        status: 429,
        ok: false,
        headers: { get: (k) => k === "Retry-After" ? "2" : null },
        text: async () => "rate limit",
        json: async () => ({}),
      };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => [],
      text: async () => "[]",
    };
  };

  // setTimeout を即時化して test を遅らせない、ただし sleep が呼ばれたことは検証
  let sleptMs = 0;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { sleptMs += (ms || 0); fn(); return 0; };

  // refreshIfNeeded を bypass: token に十分な expires_at を持たせる
  const token = {
    access_token: "fake",
    refresh_token: "r",
    expires_at: Math.floor(Date.now() / 1000) + 86400,
  };
  // auth.js refreshIfNeeded は expires_at まで余裕あれば fetch 呼ばず token を return
  const { fetchActivities } = await import("../public/js/strava.js");
  let progress = [];
  const result = await fetchActivities({
    token, after: 0, before: 1000,
    onProgress: (m) => progress.push(m),
  });

  assert.equal(n, 2, "1 回目は 429 で再試行、2 回目で 200 → loop break");
  assert.ok(sleptMs >= 2000, `Retry-After=2 を尊重して 2000ms 以上 sleep (実際 ${sleptMs}ms)`);
  assert.deepEqual(result, []);
  assert.ok(progress.some(m => /rate limit/.test(m)), "progress に rate limit 通知");

  globalThis.setTimeout = origSetTimeout;
  delete globalThis.fetch;
});

test("fetchActivities: Retry-After 上限 900 秒に clamp", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) {
      return {
        status: 429, ok: false,
        headers: { get: (k) => k === "Retry-After" ? "99999" : null },
        text: async () => "",
        json: async () => ({}),
      };
    }
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => [], text: async () => "" };
  };
  let maxSleep = 0;
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { maxSleep = Math.max(maxSleep, ms || 0); fn(); return 0; };
  const token = { access_token: "x", refresh_token: "r", expires_at: Math.floor(Date.now()/1000) + 86400 };
  const { fetchActivities } = await import("../public/js/strava.js");
  await fetchActivities({ token, after: 0, before: 1, onProgress: () => {} });
  assert.ok(maxSleep <= 900 * 1000, `9 万秒 retry でも max 900s = 900000ms に clamp (実際 ${maxSleep}ms)`);
  globalThis.setTimeout = orig;
  delete globalThis.fetch;
});
