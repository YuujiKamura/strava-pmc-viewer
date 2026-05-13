import * as auth from "./auth.js";
import * as config from "./config.js";
import { fetchActivities, fetchActivityDetail } from "./strava.js";
import {
  computePmc, decayForward, hoursUntilFresh, lastActivityEndMs,
} from "./pmc.js";
import * as cache from "./cache.js";

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const authStatus  = $("auth-status");
const connectBtn  = $("connect-btn");
const logoutBtn   = $("logout-btn");
const authShell   = $("auth-shell");
const dashShell   = $("dash-shell");
const yearButtons = $("year-buttons");
const fetchStatus = $("fetch-status");
const enrichBtn   = $("enrich-btn");
const refreshBtn  = $("refresh-btn");
const todayBtn    = $("today-btn");
const zoomStatus  = $("zoom-status");
const resetZoom   = $("reset-zoom");
const dayTitle    = $("day-title");
const dayMetrics  = $("day-metrics");
const dayWindow   = $("day-window");
const canvas      = $("pmc-chart");

// ── setup panel refs ─────────────────────────────────────────────────────
const setupPanel       = $("setup-panel");
const setupToggle      = $("setup-toggle");
const setupClientInput = $("setup-client-id");
const setupWorkerInput = $("setup-worker-url");
const setupSaveBtn     = $("setup-save");
const setupClearBtn    = $("setup-clear");
const setupStatus      = $("setup-status");
const setupCurrent     = $("setup-current");
const setupCurrentClient = $("setup-current-client");
const setupCurrentWorker = $("setup-current-worker");
const setupHostHint      = $("setup-host-hint");
const setupScopeReadAll  = $("setup-scope-readall");
if (setupHostHint) setupHostHint.textContent = location.host || location.hostname || "—";

// hero / wizard refs
const heroStartBtn   = $("hero-start");
const heroConnectBtn = $("hero-connect");

const mCtl  = $("m-ctl"), mAtl = $("m-atl"), mTsb = $("m-tsb"), mRamp = $("m-ramp");
const cardTsb = $("card-tsb");
const conditionAdvice = $("condition-advice");
const cardsAsOf = $("cards-asof");

function updateCards(points, idx) {
  if (!points.length) return;
  const p = points[idx];
  // 「今日」の card 表示時、最終 activity 終了時刻からの経過時間で時間粒度の
  // 連続時間減衰を適用する。日単位 EMA の point は「その日 EOD」相当なので、
  // 経過時間が 0 以下なら point 値そのまま、正なら decayForward で滑らかに減衰。
  const isToday = (idx === currentTodayIdx);
  let displayCtl = p.ctl, displayAtl = p.atl, displayTsb = p.tsb;
  let elapsedHours = 0;
  if (isToday && currentLastEndMs != null) {
    elapsedHours = (Date.now() - currentLastEndMs) / 3.6e6;
    if (elapsedHours > 0) {
      const adj = decayForward({ ctl: p.ctl, atl: p.atl }, elapsedHours);
      displayCtl = adj.ctl; displayAtl = adj.atl; displayTsb = adj.tsb;
    }
  }
  mCtl.textContent  = displayCtl.toFixed(1);
  mAtl.textContent  = displayAtl.toFixed(1);
  mTsb.textContent  = displayTsb.toFixed(1);
  cardTsb.classList.toggle("tsb-pos", displayTsb >= 0);
  cardTsb.classList.toggle("tsb-neg", displayTsb < 0);
  const ramp = idx >= 7 ? (p.ctl - points[idx - 7].ctl) : null;
  mRamp.textContent = ramp != null ? ramp.toFixed(1) : "—";
  if (cardsAsOf) {
    if (isToday && elapsedHours > 0) {
      cardsAsOf.textContent = `現在 (最終記録から ${formatElapsed(elapsedHours)} 経過) の推計`;
    } else if (isToday) {
      cardsAsOf.textContent = `${p.date} の最新記録直後のスナップショット`;
    } else {
      cardsAsOf.textContent = `${p.date} 時点のスナップショット`;
    }
  }

  // リカバリー予測。今日表示時は時間粒度で「あと N 日 H 時間で身体の余裕が
  // 戻る」を解析的に計算 (hoursUntilFresh)。それ以外は従来の point 逆引き。
  const forecast = forecastFromPoints(points, idx);
  if (isToday && currentLastEndMs != null && displayAtl > displayCtl) {
    const h = hoursUntilFresh({ ctl: displayCtl, atl: displayAtl });
    renderForecastHours(h);
  } else {
    renderForecast(forecast);
  }

  setConditionAdvice(displayCtl, displayAtl, displayTsb, ramp, forecast);
}

/** 時間数 → 「N 日 H 時間」or 「H 時間 M 分」 */
function formatElapsed(hours) {
  if (hours < 1) {
    const m = Math.max(0, Math.round(hours * 60));
    return `${m} 分`;
  }
  if (hours < 24) {
    let h = Math.floor(hours);
    let m = Math.round((hours - h) * 60);
    if (m >= 60) { h += 1; m = 0; }
    if (h >= 24) return `1 日`;
    return m > 0 ? `${h} 時間 ${m} 分` : `${h} 時間`;
  }
  let d = Math.floor(hours / 24);
  let h = Math.round(hours - d * 24);
  if (h >= 24) { d += 1; h = 0; }  // round 後の繰り上げ (h=24 を「日に+1」へ吸収)
  return h > 0 ? `${d} 日 ${h} 時間` : `${d} 日`;
}

/** hoursUntilFresh の結果を「あと N 日 H 時間で身体の余裕が戻る」表記に */
function renderForecastHours(hours) {
  const el = document.getElementById("cards-forecast");
  if (!el) return;
  if (hours == null || !Number.isFinite(hours) || hours <= 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `休めば → 余裕に戻るまで <strong>${formatElapsed(hours)}</strong>`;
}

/**
 * idx の次の日から「TSS が 0 連続している間」の point を返す。
 * 途中で活動 (TSS > 0) があったらそこで打ち切り。
 */
function forecastFromPoints(points, idx) {
  const out = [];
  for (let i = idx + 1; i < points.length; i++) {
    if (points[i].tss > 0) break;
    out.push(points[i]);
    if (out.length >= 14) break;  // 最大 2 週間
  }
  return out;
}

const cardsForecast = $("cards-forecast");
function renderForecast(forecast) {
  if (!cardsForecast) return;
  if (!forecast.length) { cardsForecast.innerHTML = ""; return; }
  // 1日後 / 3日後 / 7日後 / フレッシュ復帰日 を出す
  const day1  = forecast[0];
  const day3  = forecast[2]  || forecast[forecast.length - 1];
  const day7  = forecast[6]  || forecast[forecast.length - 1];
  const fresh = forecast.find(p => p.tsb >= 0);
  const parts = [];
  parts.push(`明日 (${day1.date}) TSB <strong>${day1.tsb.toFixed(0)}</strong>`);
  if (day3 !== day1) parts.push(`3日後 (${day3.date}) <strong>${day3.tsb.toFixed(0)}</strong>`);
  if (day7 !== day3 && day7 !== day1) parts.push(`1週間後 (${day7.date}) <strong>${day7.tsb.toFixed(0)}</strong>`);
  if (fresh) parts.push(`余裕に戻る日 <strong>${fresh.date}</strong> (あと ${forecast.indexOf(fresh) + 1}日)`);
  cardsForecast.innerHTML = `休めば → ${parts.join(" · ")}`;
}

function setConditionAdvice(ctl, atl, tsb, ramp, forecast) {
  if (!conditionAdvice) return;
  let msg = "", cls = "neutral";

  // Low-data branch: CTL も ATL も極端に小さいなら、TSB が ±0 でも「コンディション」を語る土台がない。
  // 機械的に「中庸」と訳すのを止めて、状況を素直に伝える。
  if (ctl < 10 && atl < 10) {
    msg = `データ収集中 ── この期間の活動量がまだ薄く、フィットネス曲線を語るに足りません。続けて記録を貯めると数値が動き始めます。`;
    cls = "neutral";
    conditionAdvice.textContent = msg;
    conditionAdvice.className = "condition-advice " + cls;
    return;
  }

  // TSB のしきい値判定 (Coggan 系の慣用) を「次のアクション」言葉に翻訳
  if (tsb <= -20) {
    msg = `直近の疲れが大きく、身体の余裕が無い状態 ── レース直前ならテーパー (調整) のタイミング。平時なら 2〜3 日完全休養を入れると伸びます。 (TSB ${tsb.toFixed(0)})`;
    cls = "neg";
  } else if (tsb <= -10) {
    msg = `直近の疲れが溜まり気味 ── 強度を落とすか、軽い日を 1 日挟むと回復が進みます。 (TSB ${tsb.toFixed(0)})`;
    cls = "neg";
  } else if (tsb >= 20) {
    msg = `身体の余裕が大きい (休みすぎ気味) ── レース直前ならピーキング完了状態。平時なら少し負荷を入れていい時期です。 (TSB +${tsb.toFixed(0)})`;
    cls = "pos";
  } else if (tsb >= 5) {
    msg = `今日はいくらでも追い込めます ── 直近の疲れが抜けて身体に余裕あり、レースや高強度の好機。 (TSB +${tsb.toFixed(0)})`;
    cls = "pos";
  } else {
    msg = `平常運転 ── 直近の疲れも溜まっていないし、特別積み上げてもいない状態。続けてトレーニングを積めます。 (TSB ${tsb.toFixed(0)})`;
    cls = "neutral";
  }

  if (ramp != null) {
    if (ramp >= 7)       msg += ` 体力が急増中 (+${ramp.toFixed(1)}/週) ── 怪我リスク域、強度の伸ばし方注意。`;
    else if (ramp >= 3)  msg += ` 体力が順調に伸びています (+${ramp.toFixed(1)}/週)。`;
    else if (ramp <= -3) msg += ` 体力が下降中 (${ramp.toFixed(1)}/週) ── 休みすぎなら戻しを。`;
  }
  // forecast がある (TSB<0 + 後続 rest 日あり) と「フレッシュまで N 日」を補足
  if (forecast && forecast.length && tsb < 0) {
    const fresh = forecast.find(p => p.tsb >= 0);
    if (fresh) {
      const days = forecast.indexOf(fresh) + 1;
      msg += ` (このまま休むと ${fresh.date} 頃に身体の余裕が戻ります、約 ${days}日。)`;
    }
  }
  conditionAdvice.textContent = msg;
  conditionAdvice.className = "condition-advice " + cls;
}

// ── state ────────────────────────────────────────────────────────────────
let token = null;
let chart = null;
let activitiesCache = new Map();  // year → Array<Activity>
let currentYear = null;
let enrichAborted = false;        // 背景 enrich 中に user が別年クリックした時の停止 flag
let currentPoints = null;         // 「現在時刻に戻る」用の最新 points 参照
let currentByDate = null;         // 同じく、day-detail panel 再描画用の byDate Map
let currentTodayIdx = 0;          // 現在年での「今日」相当の idx
let currentLastEndMs = null;      // 現在年の最終 activity 終了時刻 (ms epoch)、時間粒度の減衰起点

import { escapeHtml } from "./util.js";

// ── boot ────────────────────────────────────────────────────────────────
(async function boot() {
  wireSetupPanel();
  wireCopyButtons();
  wireHero();
  renderSetupCurrent();
  refreshWizardSteps();

  if (!config.isConfigured()) {
    onDisconnectedUnconfigured();
    return;
  }

  try {
    const fromCallback = await auth.consumeAuthCodeIfPresent();
    token = fromCallback || auth.loadToken();
  } catch (e) {
    if (e && e.message === "not_configured") {
      openSetupPanel();
      onDisconnectedUnconfigured();
      return;
    }
    showError("OAuth エラー: " + e.message);
  }
  if (token) onConnected();
  else       onDisconnected();
})();

function onConnected() {
  authStatus.textContent = `接続済${token.athlete ? ` (${token.athlete.firstname || ""} ${token.athlete.lastname || ""})` : ""}`;
  authStatus.classList.add("connected");
  connectBtn.hidden = true;
  logoutBtn.hidden  = false;
  authShell.hidden  = true;
  dashShell.hidden  = false;
  refreshWizardSteps();
  renderYearButtons();
  selectYear(new Date().getFullYear());
}

function onDisconnected() {
  authStatus.textContent = "未接続";
  authStatus.classList.remove("connected");
  connectBtn.hidden   = false;
  connectBtn.disabled = false;
  connectBtn.title    = "";
  logoutBtn.hidden    = true;
  authShell.hidden    = false;
  dashShell.hidden    = true;
  // configured + token無し: hero CTA を「Strava と接続」に切り替え
  if (heroStartBtn && heroConnectBtn) {
    heroStartBtn.hidden = true;
    heroConnectBtn.hidden = false;
  }
  const hero = document.querySelector(".hero");
  if (hero) hero.setAttribute("data-state", "configured");
  refreshWizardSteps();
}

/** config 未設定状態。connect 押下を物理的に block (Rule 1 vibe: 認可前 gate)。 */
function onDisconnectedUnconfigured() {
  authStatus.textContent = "未設定";
  authStatus.classList.remove("connected");
  connectBtn.hidden   = false;
  connectBtn.disabled = true;
  connectBtn.title    = "先に設定で Client ID と Worker URL を保存してください";
  logoutBtn.hidden    = true;
  authShell.hidden    = false;
  dashShell.hidden    = true;
  // unconfigured: hero CTA は「さっそく始める」(setup を開く)
  if (heroStartBtn && heroConnectBtn) {
    heroStartBtn.hidden = false;
    heroConnectBtn.hidden = true;
  }
  const hero = document.querySelector(".hero");
  if (hero) hero.setAttribute("data-state", "unconfigured");
  refreshWizardSteps();
}

// ── wizard step (roadmap) state ─────────────────────────────────────────
/**
 * 3 ステップカードの active/done を minimal 反映:
 *   - config 未設定: step1 active
 *   - clientId だけ入力された (= step1完了相当だが Worker URL 未): step2 active, step1 done
 *   - 両方保存済 (configured) で token 無: step3 done, step2 done, step1 done (全完了表示) → ただし接続未完なので step3 を active 強調
 *   - 認証済: 全 done
 */
function refreshWizardSteps() {
  const steps = document.querySelectorAll(".roadmap-step");
  if (!steps.length) return;
  const cfg = (typeof config !== "undefined" && config.getConfig) ? config.getConfig() : null;
  const clientTyped = (setupClientInput?.value || "").trim();
  const workerTyped = (setupWorkerInput?.value || "").trim();
  const isConfigured = !!cfg;
  const isConnected = !!token;

  let activeIdx;   // 1-based
  let doneUpTo;    // 1-based, inclusive
  if (isConnected) {
    activeIdx = 0;     // no active highlight, all done
    doneUpTo = 3;
  } else if (isConfigured) {
    activeIdx = 3;
    doneUpTo = 2;
  } else if (clientTyped && !workerTyped) {
    activeIdx = 2;
    doneUpTo = 1;
  } else if (clientTyped && workerTyped) {
    activeIdx = 3;
    doneUpTo = 2;
  } else {
    activeIdx = 1;
    doneUpTo = 0;
  }

  steps.forEach(el => {
    const n = Number(el.dataset.step);
    el.classList.toggle("done", n <= doneUpTo);
    el.classList.toggle("active", n === activeIdx);
  });
}

// ── copy buttons (dark code blocks) ──────────────────────────────────────
function wireCopyButtons() {
  for (const btn of document.querySelectorAll(".codeblock-copy")) {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.copyTarget;
      const codeEl = targetId ? document.getElementById(targetId) : null;
      if (!codeEl) return;
      const text = codeEl.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = "コピー済";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove("copied");
        }, 1500);
      } catch (e) {
        console.error("clipboard write failed", e);
      }
    });
  }
}

// ── hero CTA ─────────────────────────────────────────────────────────────
function wireHero() {
  if (heroStartBtn) {
    heroStartBtn.addEventListener("click", () => {
      openSetupPanel();
      // 開いたら focus を入れて視覚的にも「何か起きた」を伝える
      requestAnimationFrame(() => {
        setupPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => setupClientInput?.focus(), 300);
      });
    });
  }
  if (heroConnectBtn) {
    heroConnectBtn.addEventListener("click", () => connectBtn.click());
  }
}

// ── setup panel wiring ──────────────────────────────────────────────────
function openSetupPanel() {
  if (!setupPanel) return;
  setupPanel.open = true;
  if (setupToggle) setupToggle.setAttribute("aria-expanded", "true");
}

function closeSetupPanel() {
  if (!setupPanel) return;
  setupPanel.open = false;
  if (setupToggle) setupToggle.setAttribute("aria-expanded", "false");
}

function renderSetupCurrent() {
  if (!setupCurrent) return;
  const cfg = config.getConfig();
  if (!cfg) {
    setupCurrent.hidden = true;
    if (setupClientInput)    setupClientInput.value = "";
    if (setupWorkerInput)    setupWorkerInput.value = "";
    if (setupScopeReadAll)   setupScopeReadAll.checked = false;
    return;
  }
  setupCurrent.hidden = false;
  setupCurrentClient.textContent = cfg.clientId;
  let workerLabel = cfg.workerUrl;
  try { workerLabel = new URL(cfg.workerUrl).origin; } catch { /* keep raw */ }
  setupCurrentWorker.textContent = workerLabel;
  if (setupClientInput)    setupClientInput.value = cfg.clientId;
  if (setupWorkerInput)    setupWorkerInput.value = cfg.workerUrl;
  if (setupScopeReadAll)   setupScopeReadAll.checked = !!cfg.scopeReadAll;
}

function wireSetupPanel() {
  if (!setupPanel) return;

  if (setupToggle) {
    setupToggle.addEventListener("click", () => {
      if (setupPanel.open) {
        closeSetupPanel();
      } else {
        openSetupPanel();
        requestAnimationFrame(() => setupPanel.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    });
  }
  // <details> 自体の open 状態と aria-expanded を同期
  setupPanel.addEventListener("toggle", () => {
    if (setupToggle) setupToggle.setAttribute("aria-expanded", setupPanel.open ? "true" : "false");
  });

  if (setupSaveBtn) {
    setupSaveBtn.addEventListener("click", () => {
      const clientId  = (setupClientInput?.value || "").trim();
      const workerUrl = (setupWorkerInput?.value || "").trim();
      const scopeReadAll = !!(setupScopeReadAll && setupScopeReadAll.checked);
      if (!clientId || !workerUrl) {
        setupStatus.textContent = "両方の値を入力してください";
        setupStatus.className = "setup-status err";
        return;
      }
      if (!/^https?:\/\//i.test(workerUrl)) {
        setupStatus.textContent = "Worker URL は http(s):// で始めてください";
        setupStatus.className = "setup-status err";
        return;
      }
      // scope (read vs read_all) を切り替えた時、既存の access_token は古い scope の
      // まま残り続ける ── user が「絞ったつもり」で read_all のまま動く privacy 違反を
      // 防ぐため、scope が変化したら token / cache を破棄して再認証フローに戻す。
      const prev = config.getConfig();
      const scopeChanged = !!prev && prev.scopeReadAll !== scopeReadAll;
      config.saveConfig({ clientId, workerUrl, scopeReadAll });
      let extraMsg = "";
      if (scopeChanged) {
        try {
          const athId = token?.athlete?.id;
          auth.clearToken();
          if (athId != null) cache.clearAllForAthlete(athId);
        } catch { /* ignore */ }
        token = null;
        currentPoints = null;
        currentYear = null;
        activitiesCache = new Map();
        onDisconnected();
        extraMsg = " (scope が変わったので再接続が必要です)";
      }
      setupStatus.textContent = "保存しました" + extraMsg;
      setupStatus.className = "setup-status ok";
      renderSetupCurrent();
      closeSetupPanel();
      // 接続ボタン解放 (まだ未接続の場合のみ)
      if (!token) onDisconnected();
      refreshWizardSteps();
    });
  }

  if (setupClearBtn) {
    setupClearBtn.addEventListener("click", () => {
      if (!confirm("設定を消し、保存されているトークンとローカルキャッシュも全部消しますか?")) return;
      const athId = token?.athlete?.id;
      cache.clearAllForAthlete(athId);
      auth.clearToken();
      config.clearConfig();
      token = null;
      activitiesCache.clear();
      setupStatus.textContent = "クリアしました";
      setupStatus.className = "setup-status";
      renderSetupCurrent();
      openSetupPanel();
      onDisconnectedUnconfigured();
      refreshWizardSteps();
    });
  }

  // input 入力で wizard step を minimal 反映 (configured 切替前の typed 状態)
  for (const el of [setupClientInput, setupWorkerInput]) {
    if (el) el.addEventListener("input", refreshWizardSteps);
  }
}

connectBtn.addEventListener("click", () => {
  try {
    location.href = auth.authorizeUrl();
  } catch (e) {
    if (e && e.message === "not_configured") {
      openSetupPanel();
      onDisconnectedUnconfigured();
      return;
    }
    showError("認証 URL を組み立てられません: " + e.message);
  }
});
logoutBtn.addEventListener("click", () => {
  const athId = token?.athlete?.id;
  if (confirm("Strava との接続を切断し、ローカルキャッシュも消しますか?")) {
    cache.clearAllForAthlete(athId);
    auth.clearToken();
    token = null;
    activitiesCache.clear();
    onDisconnected();
  }
});

if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    if (currentYear != null) selectYear(currentYear, { force: true });
  });
}
if (todayBtn) {
  todayBtn.addEventListener("click", () => {
    if (!currentPoints) return;
    // 当年でないなら当年に戻す、当年なら現在 idx で card + day-detail を再同期
    // (chart 選択もリセット、zoom も全期間に戻す)
    const thisYear = new Date().getFullYear();
    if (currentYear !== thisYear) {
      selectYear(thisYear);
    } else {
      updateCards(currentPoints, currentTodayIdx);
      if (currentByDate) renderDay(currentTodayIdx, currentPoints, currentByDate);
      if (chart) chart.resetZoom?.();
    }
  });
}

// ── year selection ──────────────────────────────────────────────────────
function renderYearButtons() {
  while (yearButtons.firstChild) yearButtons.removeChild(yearButtons.firstChild);
  const thisYear = new Date().getFullYear();
  const years = [];
  // Strava OAuth で取得できる範囲は基本制限なし。長期 user 向けに過去 15 年を
  // default で並べる。data 無い年を押しても空 chart が出るだけ。
  for (let y = thisYear; y >= thisYear - 14; y--) years.push(y);
  const cachedSet = new Set(cache.cachedYears(token?.athlete?.id));
  for (const y of years) {
    const btn = document.createElement("button");
    const hasCache = cachedSet.has(y);
    btn.textContent = hasCache ? `${y} ●` : `${y}`;
    btn.dataset.year = y;
    btn.title = hasCache ? "取得済み (キャッシュから即表示)" : "未取得 (押すと Strava から取得)";
    btn.addEventListener("click", () => selectYear(y));
    yearButtons.appendChild(btn);
  }
}

async function selectYear(year, { force = false } = {}) {
  // 別年に切り替えた瞬間、走っている背景 enrich は停止させる (旧年の acts を
  // 書き換え続けないよう抜ける、cache への部分 save は finally で行われる)
  enrichAborted = true;
  currentYear = year;
  for (const b of yearButtons.querySelectorAll("button")) {
    b.classList.toggle("active", Number(b.dataset.year) === year);
    b.disabled = true;
  }
  // 過去年データは一度取ったら不変 (Strava 側で activity が遡って増えることはない)。
  // 「最新に更新」は現在年だけ意味があるので過去年では隠す。「詳細値を取得」は
  // 過去年でも HR / Power などの enrich が後付け可能なので有効のまま。
  const thisYear = new Date().getFullYear();
  const isCurrentYear = (year === thisYear);
  refreshBtn.hidden = !isCurrentYear;
  enrichBtn.hidden = false;
  fetchStatus.textContent = force ? "強制取得中…" : "確認中…";

  try {
    const acts = await loadYear(year, { force });
    // 当年表示時、CTL の warmup が 60 日では公式値と乖離するので、過去 3 年分
    // の cache を自動で確保 (cache 不在の年だけ API で fetch、user 操作不要)。
    // 過去年表示の時は acts 自体に warmup 60 日が含まれていれば PMC は安定する
    // ので追加 fetch しない。
    if (isCurrentYear) {
      await ensureWarmupCache(year);
    }
    const warmupActs = collectWarmupActivities(year);
    const mergedForPmc = warmupActs.length ? dedupActivities([...warmupActs, ...acts]) : acts;
    render(year, mergedForPmc, acts);
    renderYearButtons();
    // active state を再付与 (renderYearButtons で消えるので)
    for (const b of yearButtons.querySelectorAll("button")) {
      b.classList.toggle("active", Number(b.dataset.year) === year);
    }
    // 背景 enrich を非 await で起動 (画面操作を block しない)。当年で未 enrich
    // な activity が残っていれば 1.6 秒間隔で詳細値を順次補完、suffer_score /
    // NP が揃って TSS が Strava 公式に近づく。user 操作は不要、別年クリックで
    // 自動停止 (selectYear 先頭の enrichAborted = true)。
    runEnrichBackground(year, acts);
  } catch (e) {
    fetchStatus.textContent = "エラー";
    showError(e.message);
  } finally {
    for (const b of yearButtons.querySelectorAll("button")) b.disabled = false;
  }
}

async function loadYear(year, { force = false } = {}) {
  // メモリキャッシュ
  if (!force && activitiesCache.has(year)) return activitiesCache.get(year);

  // localStorage キャッシュ。過去年は「完了済みデータ」として永続扱い、
  // 現在年は「キャッシュ ${取得時刻}」として最終確認時刻を出す。
  const athId = token?.athlete?.id;
  const thisYear = new Date().getFullYear();
  const isCurrentYear = (year === thisYear);
  if (!force) {
    const cached = cache.loadYearCache(athId, year);
    if (cached) {
      activitiesCache.set(year, cached.activities);
      const label = isCurrentYear
        ? `${cached.activities.length} 件 (${year}年, キャッシュ ${cache.fetchedAtLabel(cached.fetchedAt)})`
        : `${cached.activities.length} 件 (${year}年, 完了済みデータ)`;
      fetchStatus.textContent = label;
      return cached.activities;
    }
  }

  // PMC の warmup 用に前年 11 月から取得 (CTL の初期値を埋める)
  const start = new Date(Date.UTC(year - 1, 10, 1));
  const end   = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  fetchStatus.textContent = `Strava から取得中…`;
  const acts = await fetchActivities({
    token,
    after:  Math.floor(start.getTime() / 1000),
    before: Math.floor(end.getTime() / 1000),
    onProgress: msg => fetchStatus.textContent = msg,
  });
  activitiesCache.set(year, acts);
  cache.saveYearCache(athId, year, acts);
  // token は refresh で更新されてる可能性、最新を取り直す
  token = auth.loadToken() || token;
  return acts;
}

/** 過去 3 年分の cache を warmup 用に集めて返す (cache 不在なら空配列)。 */
function collectWarmupActivities(year) {
  const athId = token?.athlete?.id;
  const out = [];
  for (let y = year - 1; y >= year - 3; y--) {
    const c = cache.loadYearCache(athId, y);
    if (c && Array.isArray(c.activities)) out.push(...c.activities);
  }
  return out;
}

/** 過去 3 年で cache 不在の年を Strava から自動取得して localStorage に保存。
 *  当年表示時に呼んで CTL warmup を 1095 日に伸ばし、Strava 公式に収束させる。
 *  user 操作なし、機械的に走る。Strava rate limit は 1 年 ≈ 1-2 calls なので
 *  最大 6-8 calls の追加、100 calls/15min 制限内で十分。 */
async function ensureWarmupCache(year) {
  const athId = token?.athlete?.id;
  const missing = [];
  for (let y = year - 1; y >= year - 3; y--) {
    if (!cache.loadYearCache(athId, y)) missing.push(y);
  }
  if (!missing.length) return;
  for (const y of missing) {
    fetchStatus.textContent = `精度向上のため ${y}年データを取得中…`;
    const start = new Date(Date.UTC(y - 1, 10, 1));
    const end   = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    try {
      const acts = await fetchActivities({
        token,
        after:  Math.floor(start.getTime() / 1000),
        before: Math.floor(end.getTime() / 1000),
        onProgress: msg => fetchStatus.textContent = `${y}年 warmup: ${msg}`,
      });
      activitiesCache.set(y, acts);
      cache.saveYearCache(athId, y, acts);
      token = auth.loadToken() || token;
    } catch (e) {
      // warmup 取得失敗は致命的でない、当年表示は続行 (60 日 warmup で fallback)
      console.warn(`warmup ${y} 取得失敗:`, e?.message);
    }
  }
}

/** activity.id でユニーク化 (warmup と loadYear の重複期間を吸収)。 */
function dedupActivities(activities) {
  const seen = new Set();
  const out = [];
  for (const a of activities) {
    if (a && a.id != null) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
    }
    out.push(a);
  }
  return out;
}

// ── render ──────────────────────────────────────────────────────────────
// activities: PMC 計算用 (warmup 含む全期間)、yearActivities: 表示年だけの活動
// (day-detail panel / lastActivityEndMs 用)。warmup なしの呼び出しでは
// yearActivities を省略すると activities をそのまま使う。
function render(year, activities, yearActivities) {
  const yearActs = yearActivities || activities;
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  const points = computePmc(activities, { from, to });

  // サマリーの基準日:
  //   - 当年表示: 今日 (date <= now の最新 point)
  //   - 過去年: その年の 12-31
  const todayStr = new Date().toISOString().slice(0, 10);
  let refIdx = points.length - 1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= todayStr) { refIdx = i; break; }
  }
  currentPoints = points;
  currentTodayIdx = refIdx;
  // 時間粒度の連続時間減衰の起点 = 当年の最終 activity 終了時刻。
  // 当年表示の時だけ意味があるので、refIdx が末尾 (= 過去年表示) なら null にしておく。
  const isCurrentYearView = (points[refIdx]?.date <= todayStr) && (refIdx < points.length - 1 || todayStr.startsWith(String(year)));
  currentLastEndMs = isCurrentYearView ? lastActivityEndMs(yearActs) : null;
  updateCards(points, refIdx);

  // activities by date for click-panel (当年だけ、warmup の過去年活動は除外)
  const byDate = new Map();
  for (const a of yearActs) {
    if (!a.start_date) continue;
    const d = a.start_date.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push({
      id: a.id, name: a.name, sport: a.sport_type || a.type,
      km: a.distance ? Math.round(a.distance / 100) / 10 : null,
      min: a.elapsed_time ? Math.round(a.elapsed_time / 60) : null,
      movingMin: a.moving_time ? Math.round(a.moving_time / 60) : null,
    });
  }

  currentByDate = byDate;
  drawChart(points, byDate);
  // 初期選択日も「現在時刻」(refIdx) ── 12/31 を中心に出す bug 修正
  renderDay(refIdx, points, byDate);
}

// ── chart ──────────────────────────────────────────────────────────────
function drawChart(points, byDate) {
  if (chart) chart.destroy();
  const labels = points.map(p => p.date);
  chart = new Chart(canvas.getContext("2d"), {
    data: {
      labels,
      datasets: [
        { type:"line", label:"TSS", data: points.map(p => p.tss > 0 ? p.tss : null),
          borderColor:"transparent", backgroundColor:"rgba(110,110,110,0.55)",
          pointRadius:2.5, pointHoverRadius:4, showLine:false, yAxisID:"yTss", order:4, spanGaps:false },
        { type:"line", label:"体力 (CTL)", data: points.map(p => p.ctl),
          borderColor:"#2e7cd6", borderWidth:2.5, pointRadius:0, tension:0.25, yAxisID:"y", order:1 },
        { type:"line", label:"直近の疲れ (ATL)", data: points.map(p => p.atl),
          borderColor:"#e26ca7", borderWidth:2, pointRadius:0, tension:0.25, yAxisID:"y", order:2 },
        { type:"line", label:"身体の余裕 (TSB)", data: points.map(p => p.tsb),
          borderColor:"#fc4c02", borderWidth:2, pointRadius:0, tension:0.25, yAxisID:"yTsb", order:3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x:    { ticks: { maxTicksLimit: 12, autoSkip: true } },
        y:    { position: "left",  title: { display: true, text: "CTL / ATL" } },
        yTsb: { position: "right", title: { display: true, text: "TSB" }, grid: { drawOnChartArea: false } },
        yTss: { display: false, beginAtZero: true },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(1)}`,
          },
        },
        zoom: {
          zoom: {
            drag: { enabled: true, backgroundColor: "rgba(252,76,2,0.15)", borderColor: "rgba(252,76,2,0.6)", borderWidth: 1 },
            wheel: { enabled: true }, pinch: { enabled: true }, mode: "x",
            onZoomComplete: ({chart}) => {
              const { min, max } = chart.scales.x;
              zoomStatus.textContent = `${labels[Math.max(0,Math.floor(min))]} 〜 ${labels[Math.min(labels.length-1,Math.ceil(max))]}`;
              resetZoom.disabled = false;
            },
          },
          pan: { enabled: true, mode: "x", modifierKey: "shift" },
          limits: { x: { min: "original", max: "original" } },
        },
      },
    },
  });
  resetZoom.onclick = () => { chart.resetZoom(); zoomStatus.textContent = "全期間表示"; resetZoom.disabled = true; };

  // click → day-detail
  let dragStartX = null;
  canvas.addEventListener("mousedown", e => { dragStartX = e.clientX; });
  canvas.addEventListener("click", e => {
    if (dragStartX != null && Math.abs(e.clientX - dragStartX) > 4) { dragStartX = null; return; }
    dragStartX = null;
    const items = chart.getElementsAtEventForMode(e, "index", { intersect: false }, true);
    if (!items.length) return;
    const idx = items[0].index;
    renderDay(idx, points, byDate);
    updateCards(points, idx);   // クリックでカードも同期、user 訂正「グラフとカードの連動を強制」
  });
}

function renderDay(idx, points, byDate) {
  const labels = points.map(p => p.date);
  const date = labels[idx], p = points[idx];
  dayTitle.textContent = `${date} を中心に ±3日`;
  dayMetrics.textContent = `CTL ${p.ctl.toFixed(1)} · ATL ${p.atl.toFixed(1)} · TSB ${p.tsb.toFixed(1)} · TSS ${p.tss.toFixed(1)}`;

  const lo = Math.max(0, idx - 3), hi = Math.min(points.length - 1, idx + 3);
  const blocks = [];
  for (let i = lo; i <= hi; i++) {
    const d = labels[i], pt = points[i];
    const acts = byDate.get(d) || [];
    const focus = i === idx;
    const metrics = `TSS ${pt.tss.toFixed(0)} · CTL ${pt.ctl.toFixed(1)} · ATL ${pt.atl.toFixed(1)} · TSB ${pt.tsb.toFixed(1)}`;
    const ul = acts.length === 0
      ? `<div class="empty">アクティビティなし</div>`
      : `<ul>${acts.map(a => {
          let t = null;
          if (a.movingMin && a.min && a.movingMin !== a.min) t = `移動 ${a.movingMin}分 / 経過 ${a.min}分`;
          else if (a.min) t = `${a.min}分`;
          const metaParts = [a.sport, a.km ? `${a.km}km` : null, t].filter(Boolean);
          const meta = escapeHtml(metaParts.join(" · "));
          const href = a.id ? `https://www.strava.com/activities/${a.id}` : null;
          const title = escapeHtml(a.name || "(無題)");
          const link = href ? `<a href="${href}" target="_blank" rel="noopener">${title}</a>` : `<span>${title}</span>`;
          return `<li>${link}<span class="meta">${meta}</span></li>`;
        }).join("")}</ul>`;
    blocks.push(`<div class="day-block${focus?' focus':''}"><div class="day-header${focus?' focus':''}"><span class="date">${escapeHtml(d)}${focus?' (選択日)':''}</span><span class="day-metrics">${escapeHtml(metrics)}</span></div>${ul}</div>`);
  }
  dayWindow.innerHTML = blocks.join("");
}

// ── enrich (詳細値取得) ─────────────────────────────────────────────────
// 一覧 API には suffer_score (= Strava 公式 Relative Effort) と NP が含まれない、
// 個別 activity API で 1 件ずつ取得して埋めると tssFor の優先順位が上位に切替り
// TSS が Strava 公式値に揃う。
//
// Strava rate limit: 100 calls / 15 分 = 9 秒/件。安全マージン込みで 10 秒間隔
// に固定。年 200 件で約 33 分、1 日制限 1000 calls にも余裕で収まる。
// 429 が返ってきたら 60 秒待機 (Strava の Retry-After も尊重) で復帰。
const ENRICH_INTERVAL_MS = 10000;

async function runEnrich(year, acts, { background = false } = {}) {
  const needs = acts.filter(a => a.suffer_score == null && a.weighted_average_watts == null);
  if (needs.length === 0) {
    if (!background) fetchStatus.textContent = "詳細値はすべて取得済";
    return;
  }
  enrichAborted = false;
  if (!background) enrichBtn.disabled = true;
  const athId = token?.athlete?.id;
  let done = 0;
  try {
    for (const a of needs) {
      if (enrichAborted || currentYear !== year) break;
      try {
        const d = await fetchActivityDetail({ token, id: a.id });
        Object.assign(a, {
          suffer_score: d.suffer_score,
          weighted_average_watts: d.weighted_average_watts,
          average_heartrate: d.average_heartrate,
          moving_time: d.moving_time,
        });
        done++;
        const remainMin = Math.ceil((needs.length - done) * ENRICH_INTERVAL_MS / 60000);
        fetchStatus.textContent = background
          ? `精度向上中 ${done}/${needs.length} (背景で進行、残り 約${remainMin}分)`
          : `詳細取得 ${done}/${needs.length} (残り 約${remainMin}分)`;
        await new Promise(r => setTimeout(r, ENRICH_INTERVAL_MS));
        // 10 件ごとに cache 保存して中断耐性 (タブ閉じても次回続きから)
        if (done % 10 === 0) cache.saveYearCache(athId, year, acts);
      } catch (e) {
        if (e.message === "rate_limit") {
          fetchStatus.textContent = "rate limit、60秒待機";
          await new Promise(r => setTimeout(r, 60000));
        } else {
          console.error(e);
        }
      }
    }
  } finally {
    // 完了・中断いずれでも cache へ反映、次回起動時に積み残しが見える
    if (done > 0) cache.saveYearCache(athId, year, acts);
    if (!background) enrichBtn.disabled = false;
    if (currentYear === year && done > 0) render(currentYear, acts);
  }
}

/** 背景進行 (await しない、画面操作を block しない、別年クリックで自動停止) */
function runEnrichBackground(year, acts) {
  // すでに enrich 不要 (= 全件取得済) なら何もしない
  const needs = acts.filter(a => a.suffer_score == null && a.weighted_average_watts == null);
  if (needs.length === 0) return;
  runEnrich(year, acts, { background: true }).catch(e => console.warn("background enrich error:", e));
}

enrichBtn.addEventListener("click", async () => {
  if (!currentYear) return;
  const acts = activitiesCache.get(currentYear) || [];
  await runEnrich(currentYear, acts);
});

function showError(msg) {
  console.error(msg);
  fetchStatus.textContent = msg;
}
