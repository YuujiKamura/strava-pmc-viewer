// Cloudflare Worker: Strava OAuth code/refresh exchange relay.
// client_secret はここで保持して static site 側には漏らさない。
//
// Endpoints:
//   POST /exchange  { code, redirect_uri } → { access_token, refresh_token, expires_at, athlete }
//   POST /refresh   { refresh_token }      → { access_token, refresh_token, expires_at }
//
// Env (wrangler secret put):
//   STRAVA_CLIENT_ID
//   STRAVA_CLIENT_SECRET
//   ALLOWED_ORIGIN  例: https://yuujikamura.github.io  (カンマ区切り複数可)

const TOKEN_URL = "https://www.strava.com/oauth/token";

// Origin が allowList に明示マッチしない場合は ACAO header を付けない (fail-closed)。
// browser は ACAO 不在を CORS reject として扱うため、token-exchange を全 origin に開かない。
// "*" fallback は禁止: ALLOWED_ORIGIN 未設定の deploy で「誰でも /exchange を叩ける」状態を防ぐ。
export function corsHeaders(origin, allowed) {
  const allowList = (allowed || "").split(",").map(s => s.trim()).filter(Boolean);
  const matched = origin && allowList.includes(origin);
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
    "Vary":                          "Origin",
  };
  if (matched) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function isOriginAllowed(origin, allowed) {
  const allowList = (allowed || "").split(",").map(s => s.trim()).filter(Boolean);
  return !!origin && allowList.includes(origin);
}

async function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function postToStrava(body) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors   = corsHeaders(origin, env.ALLOWED_ORIGIN);
    const allowed = isOriginAllowed(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, cors);
    }

    // POST は Origin allowlist を強制 (fail-closed)。
    // OPTIONS は browser の preflight 用に method/headers だけは返す。
    if (!allowed) {
      return jsonResponse({ error: "origin_not_allowed" }, 403, cors);
    }

    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ error: "invalid_json" }, 400, cors);
    }

    if (url.pathname === "/exchange") {
      const code         = body.code;
      const redirect_uri = body.redirect_uri;
      if (!code || !redirect_uri) return jsonResponse({ error: "missing_code_or_redirect_uri" }, 400, cors);

      const r = await postToStrava({
        client_id:     env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        code,
        grant_type:    "authorization_code",
        redirect_uri,
      });
      return jsonResponse(r.data, r.status, cors);
    }

    if (url.pathname === "/refresh") {
      const refresh_token = body.refresh_token;
      if (!refresh_token) return jsonResponse({ error: "missing_refresh_token" }, 400, cors);

      const r = await postToStrava({
        client_id:     env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        refresh_token,
        grant_type:    "refresh_token",
      });
      return jsonResponse(r.data, r.status, cors);
    }

    return jsonResponse({ error: "not_found" }, 404, cors);
  },
};
