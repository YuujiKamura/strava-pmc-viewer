// Strava API client (browser-side).
// 自分のデータだけを fetch する。永続化なし、memory only。

import { refreshIfNeeded } from "./auth.js";

const API = "https://www.strava.com/api/v3";

// 直前の Strava response から取った rate limit 情報。UI が残 API 数表示に使う。
// Strava は response header に "X-RateLimit-Limit: 100,1000" と
// "X-RateLimit-Usage: 60,300" を入れて返す (15min, daily の組)。
let lastRateLimit = null;

export function getLastRateLimit() { return lastRateLimit; }

function captureRateLimit(headers) {
  const limit = headers.get && headers.get("X-RateLimit-Limit");
  const usage = headers.get && headers.get("X-RateLimit-Usage");
  if (!limit || !usage) return;
  const [lim15, limDay] = limit.split(",").map(s => parseInt(s, 10));
  const [use15, useDay] = usage.split(",").map(s => parseInt(s, 10));
  if (!Number.isFinite(lim15) || !Number.isFinite(use15)) return;
  lastRateLimit = {
    fifteenUsed: use15, fifteenLimit: lim15,
    dailyUsed:   useDay, dailyLimit:   limDay,
    fifteenRemaining: Math.max(0, lim15 - use15),
    dailyRemaining:   Math.max(0, (limDay || 0) - (useDay || 0)),
  };
}

async function authHeader(token) {
  const fresh = await refreshIfNeeded(token);
  return { Authorization: `Bearer ${fresh.access_token}` };
}

/**
 * 指定 epoch 範囲のアクティビティを paginate して全件返す。
 * after, before は UNIX 秒。
 */
export async function fetchActivities({ token, after, before, onProgress }) {
  const headers = await authHeader(token);
  const all = [];
  let page = 1;
  while (true) {
    const url = new URL(API + "/athlete/activities");
    url.searchParams.set("page", page);
    url.searchParams.set("per_page", 200);  // Strava API 上限、1 年 = 1〜2 calls で済む
    if (after  != null) url.searchParams.set("after",  Math.floor(after));
    if (before != null) url.searchParams.set("before", Math.floor(before));

    const r = await fetch(url, { headers });
    captureRateLimit(r.headers);
    if (r.status === 429) {
      const retry = parseInt(r.headers.get("Retry-After") || "60", 10);
      onProgress?.(`rate limit、${retry}秒待機`);
      await sleep(Math.min(retry, 900) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`activities fetch failed: ${r.status} ${await r.text()}`);
    const batch = await r.json();
    all.push(...batch);
    onProgress?.(`${all.length} 件取得済`);
    if (batch.length < 200) break;
    page++;
  }
  return all;
}

/** DetailedActivity (suffer_score / NP / HR). 必要時のみ。 */
export async function fetchActivityDetail({ token, id }) {
  const headers = await authHeader(token);
  const r = await fetch(`${API}/activities/${id}`, { headers });
  captureRateLimit(r.headers);
  if (r.status === 429) throw new Error("rate_limit");
  if (!r.ok) throw new Error(`detail fetch failed: ${r.status}`);
  return await r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
