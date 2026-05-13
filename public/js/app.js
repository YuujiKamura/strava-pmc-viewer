import * as auth from "./auth.js";
import * as config from "./config.js";
import { fetchActivities, fetchActivityDetail } from "./strava.js";
import { computePmc } from "./pmc.js";
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
  mCtl.textContent  = p.ctl.toFixed(1);
  mAtl.textContent  = p.atl.toFixed(1);
  mTsb.textContent  = p.tsb.toFixed(1);
  cardTsb.classList.toggle("tsb-pos", p.tsb >= 0);
  cardTsb.classList.toggle("tsb-neg", p.tsb < 0);
  const ramp = idx >= 7 ? (p.ctl - points[idx - 7].ctl) : null;
  mRamp.textContent = ramp != null ? ramp.toFixed(1) : "—";
  if (cardsAsOf) cardsAsOf.textContent = `${p.date} 時点`;

  // リカバリー予測 (TSS=0 を仮定した場合の TSB が future points に既に
  // 計算済み)。points 配列を逆引きするだけ、追加計算なし。
  // 注意: 5/14 以降に活動が記録された日があると forecast の前提 (休む)
  // が崩れるので、idx 以降を「TSS が 0 の連続区間」だけ取って予測する。
  const forecast = forecastFromPoints(points, idx);
  renderForecast(forecast);

  setConditionAdvice(p.ctl, p.atl, p.tsb, ramp, forecast);
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
  if (fresh) parts.push(`フレッシュ復帰 <strong>${fresh.date}</strong> (あと ${forecast.indexOf(fresh) + 1}日)`);
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
    msg = `かなり疲労が溜まっています ── レース直前ならテーパー (調整) のタイミング。平時なら 2〜3 日完全休養を入れると伸びます。 (TSB ${tsb.toFixed(0)})`;
    cls = "neg";
  } else if (tsb <= -10) {
    msg = `疲労が溜まり気味 ── 強度を落とすか、軽い日を 1 日挟むと回復が進みます。 (TSB ${tsb.toFixed(0)})`;
    cls = "neg";
  } else if (tsb >= 20) {
    msg = `フレッシュ (休みすぎ気味) ── レース直前ならピーキング完了状態。平時なら少し負荷を入れていい時期です。 (TSB +${tsb.toFixed(0)})`;
    cls = "pos";
  } else if (tsb >= 5) {
    msg = `今日はいくらでも追い込めます ── 疲労抜けが十分、レースや高強度の好機。 (TSB +${tsb.toFixed(0)})`;
    cls = "pos";
  } else {
    msg = `フラット (平常運転) ── 疲労も溜まっていないし、特別積み上げてもいない状態。続けてトレーニングを積めます。 (TSB ${tsb.toFixed(0)})`;
    cls = "neutral";
  }

  if (ramp != null) {
    if (ramp >= 7)       msg += ` 持久力ベースが急増中 (+${ramp.toFixed(1)}/週) ── 怪我リスク域、強度の伸ばし方注意。`;
    else if (ramp >= 3)  msg += ` 持久力ベースが順調に伸びています (+${ramp.toFixed(1)}/週)。`;
    else if (ramp <= -3) msg += ` 持久力ベースが下降中 (${ramp.toFixed(1)}/週) ── 休みすぎなら戻しを。`;
  }
  // forecast がある (TSB<0 + 後続 rest 日あり) と「フレッシュまで N 日」を補足
  if (forecast && forecast.length && tsb < 0) {
    const fresh = forecast.find(p => p.tsb >= 0);
    if (fresh) {
      const days = forecast.indexOf(fresh) + 1;
      msg += ` (このまま休むと ${fresh.date} 頃にフレッシュ復帰、約 ${days}日。)`;
    }
  }
  conditionAdvice.textContent = msg;
  conditionAdvice.className = "condition-advice " + cls;
}

// demo mode 完全廃止 (2026-05-13): user 訂正「俺のデータを他の人間に見せられる
// わけがない」── プライバシー謳うツールが他人 (yuuji) の実データを demo として
// 配信する自己矛盾を解消。demo-data.json は物理削除、本コードからも demo 関連
// 経路を撤去。`?demo=1` / `#demo` / `?fresh=1` の URL param も無効化。
const DEMO_MODE = false;

// ── state ────────────────────────────────────────────────────────────────
let token = null;
let chart = null;
let activitiesCache = new Map();  // year → Array<Activity>
let currentYear = null;

const escapeHtml = s => String(s).replace(/[&<>"']/g, ch =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));

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
      config.saveConfig({ clientId, workerUrl, scopeReadAll });
      setupStatus.textContent = "保存しました";
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

// ── year selection ──────────────────────────────────────────────────────
function renderYearButtons() {
  while (yearButtons.firstChild) yearButtons.removeChild(yearButtons.firstChild);
  let years;
  if (DEMO_MODE && demoYearsAvailable && demoYearsAvailable.length) {
    years = demoYearsAvailable.slice();
  } else {
    const thisYear = new Date().getFullYear();
    years = [];
    // Strava OAuth で取得できる範囲は基本制限なし。yuuji 等の長期 user 向けに
    // 過去 15 年を default で並べる。data 無い年を押しても空 chart が出るだけ。
    for (let y = thisYear; y >= thisYear - 14; y--) years.push(y);
  }
  const cachedSet = new Set(DEMO_MODE ? years : cache.cachedYears(token?.athlete?.id));
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
  currentYear = year;
  for (const b of yearButtons.querySelectorAll("button")) {
    b.classList.toggle("active", Number(b.dataset.year) === year);
    b.disabled = true;
  }
  enrichBtn.hidden = DEMO_MODE ? true : false;
  refreshBtn.hidden = DEMO_MODE;
  fetchStatus.textContent = DEMO_MODE ? "読込中…" : (force ? "強制取得中…" : "確認中…");

  try {
    const acts = DEMO_MODE ? await loadYearDemo(year) : await loadYear(year, { force });
    // status は loadYear がキャッシュ vs API でメッセージ調整済 (force 時は上書き不要)
    render(year, acts);
    renderYearButtons();
    // active state を再付与 (renderYearButtons で消えるので)
    for (const b of yearButtons.querySelectorAll("button")) {
      b.classList.toggle("active", Number(b.dataset.year) === year);
    }
  } catch (e) {
    fetchStatus.textContent = "エラー";
    showError(e.message);
  } finally {
    for (const b of yearButtons.querySelectorAll("button")) b.disabled = false;
  }
}

// demo mode: 全件 cache を 年 で filter (前年11月〜当年末で warmup 込み)
async function loadYearDemo(year) {
  if (activitiesCache.has(year)) return activitiesCache.get(year);
  if (!demoActivities) throw new Error("demo データ未ロード");
  const startMs = Date.UTC(year - 1, 10, 1);                  // 前年11月1日
  const endMs   = Date.UTC(year, 11, 31, 23, 59, 59);         // 当年12月31日
  const acts = demoActivities.filter(a => {
    if (!a.start_date) return false;
    const t = Date.parse(a.start_date);
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
  activitiesCache.set(year, acts);
  return acts;
}

async function loadYear(year, { force = false } = {}) {
  // メモリキャッシュ
  if (!force && activitiesCache.has(year)) return activitiesCache.get(year);

  // localStorage キャッシュ
  const athId = token?.athlete?.id;
  if (!force) {
    const cached = cache.loadYearCache(athId, year);
    if (cached) {
      activitiesCache.set(year, cached.activities);
      fetchStatus.textContent = `${cached.activities.length} 件 (${year}年, キャッシュ ${cache.fetchedAtLabel(cached.fetchedAt)})`;
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

// ── render ──────────────────────────────────────────────────────────────
function render(year, activities) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  const points = computePmc(activities, { from, to });

  // サマリーの基準日:
  //   - 当年表示: 今日 (date <= now の最新 point)
  //   - 過去年: その年の 12-31
  // 「未来側の 12-31」を取ると EMA が減衰して 0.1 になってしまうバグ修正。
  const todayStr = new Date().toISOString().slice(0, 10);
  let refIdx = points.length - 1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= todayStr) { refIdx = i; break; }
  }
  updateCards(points, refIdx);

  // activities by date for click-panel
  const byDate = new Map();
  for (const a of activities) {
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

  drawChart(points, byDate);
  renderDay(points.length - 1, points, byDate);
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
        { type:"line", label:"Fitness (CTL)", data: points.map(p => p.ctl),
          borderColor:"#2e7cd6", borderWidth:2.5, pointRadius:0, tension:0.25, yAxisID:"y", order:1 },
        { type:"line", label:"Fatigue (ATL)", data: points.map(p => p.atl),
          borderColor:"#e26ca7", borderWidth:2, pointRadius:0, tension:0.25, yAxisID:"y", order:2 },
        { type:"line", label:"Form (TSB)", data: points.map(p => p.tsb),
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
enrichBtn.addEventListener("click", async () => {
  if (!currentYear) return;
  const acts = activitiesCache.get(currentYear) || [];
  const needs = acts.filter(a => a.suffer_score == null && a.weighted_average_watts == null);
  if (needs.length === 0) {
    fetchStatus.textContent = "詳細値はすべて取得済";
    return;
  }
  enrichBtn.disabled = true;
  let done = 0;
  for (const a of needs) {
    try {
      const d = await fetchActivityDetail({ token, id: a.id });
      Object.assign(a, {
        suffer_score: d.suffer_score,
        weighted_average_watts: d.weighted_average_watts,
        average_heartrate: d.average_heartrate,
        moving_time: d.moving_time,
      });
      done++;
      fetchStatus.textContent = `詳細取得 ${done}/${needs.length}`;
      await new Promise(r => setTimeout(r, 1600));
    } catch (e) {
      if (e.message === "rate_limit") { fetchStatus.textContent = "rate limit、60秒待機"; await new Promise(r => setTimeout(r, 60000)); }
      else { console.error(e); }
    }
  }
  enrichBtn.disabled = false;
  render(currentYear, acts);
});

function showError(msg) {
  console.error(msg);
  fetchStatus.textContent = msg;
}
