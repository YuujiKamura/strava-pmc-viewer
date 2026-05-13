// User-specific Strava App + Worker config, persisted in localStorage.
// 各 visitor が自分の Strava API Application と Cloudflare Worker を立てて
// その値をここに入れる (B 案: 共有 worker を持たない, fully self-hosted)。

const STORAGE_KEY = "strava_pmc_config_v1";

/**
 * @returns {{clientId: string, workerUrl: string, scopeReadAll: boolean} | null}
 *   両方埋まっていれば object、片方でも欠ければ null。
 */
export function getConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const clientId  = typeof obj.clientId  === "string" ? obj.clientId.trim()  : "";
    const workerUrl = typeof obj.workerUrl === "string" ? obj.workerUrl.trim() : "";
    if (!clientId || !workerUrl) return null;
    const normalizedWorker = workerUrl.replace(/\/+$/, "");
    return {
      clientId,
      workerUrl: normalizedWorker,
      scopeReadAll: !!obj.scopeReadAll,
    };
  } catch {
    return null;
  }
}

/**
 * @param {{clientId: string, workerUrl: string, scopeReadAll?: boolean}} cfg
 */
export function saveConfig({ clientId, workerUrl, scopeReadAll }) {
  const payload = {
    clientId:  String(clientId  || "").trim(),
    workerUrl: String(workerUrl || "").trim().replace(/\/+$/, ""),
    scopeReadAll: !!scopeReadAll,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

/** @returns {boolean} 両方埋まってる? */
export function isConfigured() {
  return getConfig() !== null;
}
