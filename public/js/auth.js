// Strava OAuth flow (PKCE-less since Strava requires client_secret).
// client_secret は Cloudflare Worker 側で保持、こちらは Worker に code を投げて
// token を貰う。token は localStorage (本人 device 内のみ)。

const STORAGE_KEY = "strava_pmc_token_v1";

export const CONFIG = {
  // ↓ ユーザーが setup 時に書き換えるところ。Strava で My API Application を
  //   作って取得した client_id、Worker をデプロイしたら URL を入れる。
  clientId:  "234530",  // demo: 自分の dev app
  workerUrl: "http://localhost:8787",  // wrangler dev のデフォルト
  redirectUri: location.origin + location.pathname,  // 自動: 今いる URL
  scope: "activity:read_all",
};

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
  const p = new URLSearchParams({
    client_id: CONFIG.clientId,
    redirect_uri: CONFIG.redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: CONFIG.scope,
  });
  return `https://www.strava.com/oauth/authorize?${p}`;
}

export async function exchangeCode(code) {
  const r = await fetch(CONFIG.workerUrl + "/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: CONFIG.redirectUri }),
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

  const r = await fetch(CONFIG.workerUrl + "/refresh", {
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
