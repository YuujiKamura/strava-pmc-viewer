// Cloudflare Worker: Strava OAuth code/refresh exchange relay + rate ping.
// client_secret はここで保持して static site 側には漏らさない。
//
// Endpoints:
//   POST /exchange     { code, redirect_uri } → { access_token, refresh_token, expires_at, athlete }
//   POST /refresh      { refresh_token }      → { access_token, refresh_token, expires_at }
//   POST /rate-status  { access_token }       → { fifteenUsed, fifteenLimit, dailyUsed, dailyLimit }
//     ── Strava の X-RateLimit-* は CORS で expose されておらず browser から読めないため
//        Worker 経由で /athlete を 1 回叩いて Strava の response header から抽出して返す
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

    if (url.pathname === "/rate-status") {
      const access_token = body.access_token;
      if (!access_token) return jsonResponse({ error: "missing_access_token" }, 400, cors);

      // /athlete を 1 回叩く (軽量 endpoint、現 user 情報を返すだけ)。本来の目的は
      // Strava response の X-RateLimit-Limit / X-RateLimit-Usage 抽出のみ。
      const r = await fetch("https://www.strava.com/api/v3/athlete", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const limitHeader = r.headers.get("X-RateLimit-Limit") || "";
      const usageHeader = r.headers.get("X-RateLimit-Usage") || "";
      const [lim15, limDay] = limitHeader.split(",").map(s => parseInt(s, 10));
      const [use15, useDay] = usageHeader.split(",").map(s => parseInt(s, 10));
      if (!Number.isFinite(lim15) || !Number.isFinite(use15)) {
        return jsonResponse({ error: "rate_headers_missing", status: r.status }, 502, cors);
      }
      return jsonResponse({
        fifteenUsed: use15, fifteenLimit: lim15,
        dailyUsed:   useDay || 0, dailyLimit: limDay || 0,
        fifteenRemaining: Math.max(0, lim15 - use15),
        dailyRemaining:   Math.max(0, (limDay || 0) - (useDay || 0)),
        fetchedAt: Date.now(),
      }, 200, cors);
    }

    return jsonResponse({ error: "not_found" }, 404, cors);
  },
};
