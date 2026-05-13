// Strava OAuth flow (PKCE-less since Strava requires client_secret).
// client_secret は Cloudflare Worker 側で保持、こちらは Worker に code を投げて
// token を貰う。token は localStorage (本人 device 内のみ)。
//
// B 案: clientId / workerUrl は user ごとに config.js (localStorage) から読む。
// この module はハードコード値を持たない、毎呼び出しで getConfig() を取り直す。

import { getConfig } from "./config.js";

const STORAGE_KEY = "strava_pmc_token_v1";
// OAuth `state` パラメータ用 (RFC 6749 §10.12 login-CSRF / token-injection 防御)。
// authorize 直前に random 生成して sessionStorage、callback で URL の state と照合する。
// sessionStorage を選んだのは「same tab 内 1 回限り、tab を閉じれば消えて再利用不可」のため。
const STATE_KEY = "strava_pmc_oauth_state_v1";

// scope は最小権限を default に。public activity だけで PMC は計算できる。
// private 活動も対象にしたい visitor は config に `scopeReadAll: true` を保存
// (UI のチェックボックスから) すると `activity:read_all` に格上げされる。
const SCOPE_PUBLIC = "activity:read";
const SCOPE_ALL    = "activity:read_all";
export function scopeFor(cfg) {
  return cfg && cfg.scopeReadAll ? SCOPE_ALL : SCOPE_PUBLIC;
}

/** 32-hex-char random state。crypto.getRandomValues を使う。 */
function generateState() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
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
  const state = generateState();
  try { sessionStorage.setItem(STATE_KEY, state); }
  catch { /* private mode 等で setItem 失敗 → state は URL 側のみ、照合段で fail-close */ }
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    approval_prompt: "auto",
    scope: scopeFor(cfg),
    state,
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

/** location.search 内の ?code= を消費して token を返す。auth callback で 1 回だけ。
 * RFC 6749 §10.12: state を照合し、一致しなければ throw して exchange は走らせない。 */
export async function consumeAuthCodeIfPresent() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return null;
  const returnedState = params.get("state");
  let savedState = null;
  try { savedState = sessionStorage.getItem(STATE_KEY); } catch { /* ignore */ }
  // URL を綺麗に戻す (history 残さない)
  history.replaceState(null, "", location.pathname);
  try { sessionStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
  if (!savedState || !returnedState || savedState !== returnedState) {
    throw new Error("oauth_state_mismatch");
  }
  return await exchangeCode(code);
}
