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
if (setupHostHint) setupHostHint.textContent = location.host || location.hostname || "—";

const mCtl  = $("m-ctl"), mAtl = $("m-atl"), mTsb = $("m-tsb"), mRamp = $("m-ramp");
const cardTsb = $("card-tsb");

// ── demo mode detection ─────────────────────────────────────────────────
// `?demo=1` か `#demo` で OAuth スキップ → ./demo-data.json をローカル読込
const DEMO_MODE = (() => {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get("demo") === "1") return true;
    if ((url.hash || "").toLowerCase().includes("demo")) return true;
  } catch { /* noop */ }
  return false;
})();

// ── state ────────────────────────────────────────────────────────────────
let token = null;
let chart = null;
let activitiesCache = new Map();  // year → Array<Activity>
let currentYear = null;
let demoActivities = null;        // demo mode: 全件 (year filter 前) cache
let demoYearsAvailable = null;    // demo mode: data 範囲から決まる年度配列

const escapeHtml = s => String(s).replace(/[&<>"']/g, ch =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));

// ── boot ────────────────────────────────────────────────────────────────
(async function boot() {
  if (DEMO_MODE) {
    // demo は config 不要、setup パネルも隠す
    if (setupPanel) setupPanel.hidden = true;
    if (setupToggle) setupToggle.hidden = true;
    await bootDemo();
    return;
  }

  wireSetupPanel();
  renderSetupCurrent();

  if (!config.isConfigured()) {
    // config 未設定: setup を強制展開、接続ボタン無効化
    openSetupPanel();
    setupStatus.textContent = "先に Setup を完了してください (clientId と Worker URL の両方が必要)";
    setupStatus.className = "setup-status err";
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

async function bootDemo() {
  const banner = $("demo-banner");
  if (banner) banner.hidden = false;
  authStatus.textContent = "demo: 接続なし";
  connectBtn.hidden = true;
  logoutBtn.hidden  = true;
  authShell.hidden  = true;
  dashShell.hidden  = false;

  try {
    const res = await fetch("./demo-data.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    demoActivities = Array.isArray(data) ? data : (Array.isArray(data.activities) ? data.activities : null);
    if (!demoActivities) throw new Error("demo-data.json: 配列または {activities:[…]} 形式が必要");
  } catch (e) {
    showDemoLoadError(e);
    return;
  }

  demoYearsAvailable = computeDemoYears(demoActivities);
  const detail = $("demo-banner-detail");
  if (detail) {
    const n = demoActivities.length;
    const yrs = demoYearsAvailable.length
      ? `${demoYearsAvailable[demoYearsAvailable.length - 1]}〜${demoYearsAvailable[0]}`
      : "—";
    detail.textContent = ` (${n} 件, ${yrs})`;
  }

  renderYearButtons();
  const initial = demoYearsAvailable.includes(new Date().getFullYear())
    ? new Date().getFullYear()
    : demoYearsAvailable[0] ?? new Date().getFullYear();
  selectYear(initial);
}

function computeDemoYears(acts) {
  const years = new Set();
  for (const a of acts) {
    if (!a.start_date) continue;
    const y = Number(a.start_date.slice(0, 4));
    if (Number.isFinite(y)) years.add(y);
  }
  return Array.from(years).sort((a, b) => b - a);  // 新しい順
}

function showDemoLoadError(e) {
  const msg = `demo-data.json の読み込みに失敗: ${e && e.message ? e.message : e}. ` +
              `\`bin/rails runner scripts/export_demo_json.rb\` で生成してください。`;
  fetchStatus.textContent = msg;
  if (yearButtons) yearButtons.innerHTML = "";
  console.error(msg);
}

function onConnected() {
  authStatus.textContent = `接続済${token.athlete ? ` (${token.athlete.firstname || ""} ${token.athlete.lastname || ""})` : ""}`;
  connectBtn.hidden = true;
  logoutBtn.hidden  = false;
  authShell.hidden  = true;
  dashShell.hidden  = false;
  renderYearButtons();
  selectYear(new Date().getFullYear());
}

function onDisconnected() {
  authStatus.textContent = "未接続";
  connectBtn.hidden   = false;
  connectBtn.disabled = false;
  connectBtn.title    = "";
  logoutBtn.hidden    = true;
  authShell.hidden    = false;
  dashShell.hidden    = true;
}

/** config 未設定状態。connect 押下を物理的に block (Rule 1 vibe: 認可前 gate)。 */
function onDisconnectedUnconfigured() {
  authStatus.textContent = "未設定";
  connectBtn.hidden   = false;
  connectBtn.disabled = true;
  connectBtn.title    = "先に Setup で Client ID と Worker URL を保存してください";
  logoutBtn.hidden    = true;
  authShell.hidden    = false;
  dashShell.hidden    = true;
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
    if (setupClientInput) setupClientInput.value = "";
    if (setupWorkerInput) setupWorkerInput.value = "";
    return;
  }
  setupCurrent.hidden = false;
  // clientId は完全表示、workerUrl は origin だけ (path / token を出さない)
  setupCurrentClient.textContent = cfg.clientId;
  let workerLabel = cfg.workerUrl;
  try { workerLabel = new URL(cfg.workerUrl).origin; } catch { /* keep raw */ }
  setupCurrentWorker.textContent = workerLabel;
  // input にも現在値を流し込む (再編集しやすく)
  if (setupClientInput) setupClientInput.value = cfg.clientId;
  if (setupWorkerInput) setupWorkerInput.value = cfg.workerUrl;
}

function wireSetupPanel() {
  if (!setupPanel) return;

  if (setupToggle) {
    setupToggle.addEventListener("click", () => {
      if (setupPanel.open) closeSetupPanel(); else openSetupPanel();
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
      if (!clientId || !workerUrl) {
        setupStatus.textContent = "両方の値を入力してください";
        setupStatus.className = "setup-status err";
        return;
      }
      // 簡易 validation: workerUrl は http(s) 始まり
      if (!/^https?:\/\//i.test(workerUrl)) {
        setupStatus.textContent = "Worker URL は http(s):// で始めてください";
        setupStatus.className = "setup-status err";
        return;
      }
      config.saveConfig({ clientId, workerUrl });
      setupStatus.textContent = "保存しました";
      setupStatus.className = "setup-status ok";
      renderSetupCurrent();
      closeSetupPanel();
      // 接続ボタン解放 (まだ未接続の場合のみ)
      if (!token) onDisconnected();
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
    });
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
    for (let y = thisYear; y >= thisYear - 7; y--) years.push(y);
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

  const today = points[points.length - 1];
  mCtl.textContent  = today.ctl.toFixed(1);
  mAtl.textContent  = today.atl.toFixed(1);
  mTsb.textContent  = today.tsb.toFixed(1);
  cardTsb.classList.toggle("tsb-pos", today.tsb >= 0);
  cardTsb.classList.toggle("tsb-neg", today.tsb < 0);
  const ramp = points.length > 7 ? (today.ctl - points[points.length - 8].ctl) : null;
  mRamp.textContent = ramp != null ? ramp.toFixed(1) : "—";

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
    renderDay(items[0].index, points, byDate);
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
