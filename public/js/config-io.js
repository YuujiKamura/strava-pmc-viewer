// 設定 (Client ID + Worker URL + scope) をローカルファイルに書き出し / 読み込む I/O。
// File System Access API (Chrome/Edge) で初回に user に保存先を選んでもらい、
// File handle を IndexedDB に保存しておくと、2 回目以降は黙って同じファイルに
// 上書き保存 / 復元できる ── 「数日後 localStorage が消えてても、ボタン 1 つで戻せる」。
// Firefox / Safari など FSAcc 未サポートは素の download / <input type="file"> に fallback。

const DB_NAME = "strava-pmc-config-io";
const DB_STORE = "handles";
const HANDLE_KEY = "config_file_handle";
const FILENAME_DEFAULT = "strava-pmc-config.json";
const PAYLOAD_FORMAT = "strava-pmc-config";
const PAYLOAD_VERSION = 1;

function hasFSAcc() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function clearHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function ensurePermission(handle, mode /* "readwrite" | "read" */) {
  if (!handle) return false;
  const opts = { mode };
  // queryPermission の結果は 'granted' / 'denied' / 'prompt'
  if ((await handle.queryPermission(opts)) === "granted") return true;
  // 'prompt' の時 user gesture 中なら requestPermission で granted に昇格可能
  return (await handle.requestPermission(opts)) === "granted";
}

/** JSON encode する payload を組み立てる (pure)。test 可能。 */
export function buildPayload(cfg, now = new Date()) {
  return JSON.stringify({
    _format: PAYLOAD_FORMAT,
    _version: PAYLOAD_VERSION,
    config: {
      clientId: String(cfg?.clientId || ""),
      workerUrl: String(cfg?.workerUrl || ""),
      scopeReadAll: cfg?.scopeReadAll !== false,
    },
    savedAt: now.toISOString(),
  }, null, 2);
}

/** JSON text を parse して config を取り出す (pure)。test 可能。
 *  @returns {{ok:true, config:object} | {ok:false, reason:string}}
 */
export function parsePayload(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "JSON 形式が壊れています" }; }
  // 旧版 / 素の config object を直接書いた場合の互換: parsed.config が無ければ parsed 自体を見る
  const cfg = parsed && typeof parsed === "object" && parsed.config && typeof parsed.config === "object"
    ? parsed.config
    : parsed;
  if (!cfg || typeof cfg !== "object") return { ok: false, reason: "設定オブジェクトがありません" };
  const clientId = typeof cfg.clientId === "string" ? cfg.clientId.trim() : "";
  const workerUrl = typeof cfg.workerUrl === "string" ? cfg.workerUrl.trim() : "";
  if (!clientId || !workerUrl) return { ok: false, reason: "clientId / workerUrl が不完全です" };
  return {
    ok: true,
    config: {
      clientId,
      workerUrl,
      scopeReadAll: cfg.scopeReadAll !== false,
    },
  };
}

/** 現在キャッシュされている保存先ファイル名 (= 次回 export ボタンの行き先)。
 *  permission の有無は問わない、name だけ。null = 未設定。 */
export async function getSavedFileName() {
  if (!hasFSAcc()) return null;
  try {
    const h = await getHandle();
    return h ? (h.name || null) : null;
  } catch { return null; }
}

/** 保存先 handle を IndexedDB から消す (= 次回 export はダイアログから選び直し)。 */
export async function forgetSavedFile() {
  try { await clearHandle(); } catch { /* ignore */ }
}

/**
 * 設定をファイルに書く。FSAcc あり: 初回ダイアログで選んだ handle を IDB に保存、
 * 2 回目以降は黙って同じファイルに上書き。reselect=true で強制ダイアログ。
 * FSAcc 無し: 毎回 Blob を download (Chrome 以外の素 fallback)。
 * 必ず user gesture (button click handler) 内から呼ぶこと。
 * @returns {Promise<{ok:true, name:string} | {ok:false, reason:string}>}
 */
export async function exportConfig(cfg, { reselect = false } = {}) {
  if (!cfg || !cfg.clientId || !cfg.workerUrl) {
    return { ok: false, reason: "設定が未保存です (先に Client ID と Worker URL を入力)" };
  }
  const payload = buildPayload(cfg);

  if (!hasFSAcc()) {
    return downloadFallback(payload);
  }

  let handle = null;
  if (!reselect) {
    try { handle = await getHandle(); } catch { /* ignore */ }
    if (handle && !(await ensurePermission(handle, "readwrite"))) handle = null;
  }

  if (!handle) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: FILENAME_DEFAULT,
        types: [{
          description: "Strava PMC Config",
          accept: { "application/json": [".json"] },
        }],
      });
    } catch (e) {
      // user cancel か permission denied
      if (e && e.name === "AbortError") return { ok: false, reason: "保存をキャンセルしました" };
      return { ok: false, reason: e?.message || "ファイル選択に失敗" };
    }
    try { await putHandle(handle); } catch { /* IDB 失敗は致命的でない、書き込みは続行 */ }
  }

  try {
    const writable = await handle.createWritable();
    await writable.write(payload);
    await writable.close();
    return { ok: true, name: handle.name };
  } catch (e) {
    return { ok: false, reason: e?.message || "書き込み失敗" };
  }
}

/**
 * 設定をファイルから読み出す。FSAcc あり: cached handle があれば黙ってその file を
 * 読む (= ダイアログ無し)、無ければ open file picker。reselect=true で強制ダイアログ。
 * FSAcc 無し: <input type="file"> でユーザーに選ばせる。
 * 必ず user gesture (button click handler) 内から呼ぶこと。
 * @returns {Promise<{ok:true, config:object, name:string} | {ok:false, reason:string}>}
 */
export async function importConfig({ reselect = false } = {}) {
  if (!hasFSAcc()) {
    try {
      const text = await fallbackOpen();
      const r = parsePayload(text);
      return r.ok ? { ...r, name: "(file)" } : r;
    } catch (e) {
      return { ok: false, reason: e?.message || "読み込みキャンセル" };
    }
  }

  let handle = null;
  if (!reselect) {
    try { handle = await getHandle(); } catch { /* ignore */ }
    if (handle && !(await ensurePermission(handle, "read"))) handle = null;
  }

  if (!handle) {
    try {
      const [picked] = await window.showOpenFilePicker({
        types: [{
          description: "Strava PMC Config",
          accept: { "application/json": [".json"] },
        }],
        multiple: false,
      });
      handle = picked;
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, reason: "読み込みをキャンセルしました" };
      return { ok: false, reason: e?.message || "ファイル選択に失敗" };
    }
    try { await putHandle(handle); } catch { /* ignore */ }
  }

  try {
    const file = await handle.getFile();
    const text = await file.text();
    const r = parsePayload(text);
    return r.ok ? { ...r, name: handle.name } : r;
  } catch (e) {
    return { ok: false, reason: e?.message || "読み込み失敗" };
  }
}

// ── fallback (FSAcc 未サポートの Firefox / Safari 等) ──────────────────────

function downloadFallback(payload) {
  try {
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = FILENAME_DEFAULT;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return Promise.resolve({ ok: true, name: FILENAME_DEFAULT });
  } catch (e) {
    return Promise.resolve({ ok: false, reason: e?.message || "ダウンロード失敗" });
  }
}

function fallbackOpen() {
  return new Promise((resolve, reject) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json";
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.addEventListener("change", () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return reject(new Error("ファイルが選ばれませんでした"));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(f);
    });
    inp.click();
  });
}
