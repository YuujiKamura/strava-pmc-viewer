// Strava API client (browser-side).
// 自分のデータだけを fetch する。永続化なし、memory only。

import { refreshIfNeeded } from "./auth.js";

const API = "https://www.strava.com/api/v3";

// Strava の rate limit: 100 calls / 15 min, 1000 calls / day。
// 公式 response の X-RateLimit-* header は CORS で expose されておらず browser
// JS から読めない (試したが Strava 側に Access-Control-Expose-Headers 未設定)。
// → 自前で fetch のタイムスタンプを log して残数を計算する。
// 制限は self-imposed (Strava と完全一致しない可能性: 別 tab・別アプリで叩いた分
// はカウント漏れ) だが、本ツールが暴走しない上限としては機能する。
export const STRAVA_LIMIT_15MIN = 100;
export const STRAVA_LIMIT_DAY   = 1000;
const apiCallLog = [];  // ms epoch の配列

function logApiCall() {
  const now = Date.now();
  apiCallLog.push(now);
  // 24h より古い entry は捨てる (memory リーク防止)
  const cutoff = now - 86400000;
  while (apiCallLog.length && apiCallLog[0] < cutoff) apiCallLog.shift();
}

/** 直近 15min / 24h で叩いた回数から残り API 数を計算して返す。 */
export function getRateBudget() {
  const now = Date.now();
  const win15 = now - 900000;
  let c15 = 0;
  for (let i = apiCallLog.length - 1; i >= 0; i--) {
    if (apiCallLog[i] >= win15) c15++; else break;
  }
  const cDay = apiCallLog.length;
  return {
    fifteenUsed: c15,
    fifteenLimit: STRAVA_LIMIT_15MIN,
    fifteenRemaining: Math.max(0, STRAVA_LIMIT_15MIN - c15),
    dailyUsed: cDay,
    dailyLimit: STRAVA_LIMIT_DAY,
    dailyRemaining: Math.max(0, STRAVA_LIMIT_DAY - cDay),
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

    logApiCall();
    const r = await fetch(url, { headers });
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
  logApiCall();
  const r = await fetch(`${API}/activities/${id}`, { headers });
  if (r.status === 429) throw new Error("rate_limit");
  if (!r.ok) throw new Error(`detail fetch failed: ${r.status}`);
  return await r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
