// Strava OAuth flow (PKCE-less since Strava requires client_secret).
// client_secret は Cloudflare Worker 側で保持、こちらは Worker に code を投げて
// token を貰う。token は localStorage (本人 device 内のみ)。
//
// B 案: clientId / workerUrl は user ごとに config.js (localStorage) から読む。
// この module はハードコード値を持たない、毎呼び出しで getConfig() を取り直す。

import { getConfig } from "./config.js";

const STORAGE_KEY = "strava_pmc_token_v1";
// scope は最小権限を default に。public activity だけで PMC は計算できる。
// private 活動も対象にしたい visitor は config に `scopeReadAll: true` を保存
// (UI のチェックボックスから) すると `activity:read_all` に格上げされる。
const SCOPE_PUBLIC = "activity:read";
const SCOPE_ALL    = "activity:read_all";
function scopeFor(cfg) {
  return cfg && cfg.scopeReadAll ? SCOPE_ALL : SCOPE_PUBLIC;
}

/** redirect_uri は今いる URL (origin + pathname)、host 移動には追従しない。 */
function redirectUri() {
  return location.origin + location.pathname;
}

/** config 必須の操作で呼ぶ。未設定なら例外で auth フローを止める。 */
function requireConfig() {
  const cfg = getConfig();
  if (!cfg) throw new Error("not_configured");
  return cfg;
}

export function loadToken() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
  catch { return null; }
}

export function saveToken(tok) {
  // localStorage に置く: 再訪時に OAuth スキップ。本人デバイス内のみ。
  // (sessionStorage は tab を閉じれば消えるが、再訪のたびに OAuth しなおしの UX が辛い)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tok));
}

export function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}

export function authorizeUrl() {
  const cfg = requireConfig();
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    approval_prompt: "auto",
    scope: scopeFor(cfg),
  });
  return `https://www.strava.com/oauth/authorize?${p}`;
}

export async function exchangeCode(code) {
  const cfg = requireConfig();
  const r = await fetch(cfg.workerUrl + "/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri() }),
  });
  if (!r.ok) throw new Error(`exchange failed: ${r.status} ${await r.text()}`);
  const tok = await r.json();
  saveToken(tok);
  return tok;
}

export async function refreshIfNeeded(tok) {
  if (!tok || !tok.expires_at) return tok;
  const now = Math.floor(Date.now() / 1000);
  if (tok.expires_at - now > 300) return tok;  // 5 分以上余裕あれば不要

  const cfg = requireConfig();
  const r = await fetch(cfg.workerUrl + "/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: tok.refresh_token }),
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const fresh = await r.json();
  // Strava は refresh で athlete を返さない、merge して保持
  const merged = { ...tok, ...fresh };
  saveToken(merged);
  return merged;
}

/** location.search 内の ?code= を消費して token を返す。auth callback で 1 回だけ。 */
export async function consumeAuthCodeIfPresent() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return null;
  // URL を綺麗に戻す (history 残さない)
  history.replaceState(null, "", location.pathname);
  return await exchangeCode(code);
}
