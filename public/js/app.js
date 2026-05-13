import * as auth from "./auth.js";
import { fetchActivities, fetchActivityDetail } from "./strava.js";
import { computePmc } from "./pmc.js";

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
const zoomStatus  = $("zoom-status");
const resetZoom   = $("reset-zoom");
const dayTitle    = $("day-title");
const dayMetrics  = $("day-metrics");
const dayWindow   = $("day-window");
const canvas      = $("pmc-chart");

const mCtl  = $("m-ctl"), mAtl = $("m-atl"), mTsb = $("m-tsb"), mRamp = $("m-ramp");
const cardTsb = $("card-tsb");

// ── state ────────────────────────────────────────────────────────────────
let token = null;
let chart = null;
let activitiesCache = new Map();  // year → Array<Activity>
let currentYear = null;

const escapeHtml = s => String(s).replace(/[&<>"']/g, ch =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));

// ── boot ────────────────────────────────────────────────────────────────
(async function boot() {
  try {
    const fromCallback = await auth.consumeAuthCodeIfPresent();
    token = fromCallback || auth.loadToken();
  } catch (e) {
    showError("OAuth エラー: " + e.message);
  }
  if (token) onConnected();
  else       onDisconnected();
})();

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
  connectBtn.hidden = false;
  logoutBtn.hidden  = true;
  authShell.hidden  = false;
  dashShell.hidden  = true;
}

connectBtn.addEventListener("click", () => {
  location.href = auth.authorizeUrl();
});
logoutBtn.addEventListener("click", () => {
  auth.clearToken();
  token = null;
  activitiesCache.clear();
  onDisconnected();
});

// ── year selection ──────────────────────────────────────────────────────
function renderYearButtons() {
  const thisYear = new Date().getFullYear();
  yearButtons.innerHTML = "";
  // 過去 8 年分を出す (Strava で取得可能な範囲、user が必要に応じて選ぶ)
  for (let y = thisYear; y >= thisYear - 7; y--) {
    const btn = document.createElement("button");
    btn.textContent = y;
    btn.dataset.year = y;
    btn.addEventListener("click", () => selectYear(y));
    yearButtons.appendChild(btn);
  }
}

async function selectYear(year) {
  currentYear = year;
  for (const b of yearButtons.querySelectorAll("button")) {
    b.classList.toggle("active", Number(b.dataset.year) === year);
    b.disabled = true;
  }
  enrichBtn.hidden = false;
  fetchStatus.textContent = "取得中…";

  try {
    const acts = await loadYear(year);
    fetchStatus.textContent = `${acts.length} 件 (${year}年)`;
    render(year, acts);
  } catch (e) {
    fetchStatus.textContent = "エラー";
    showError(e.message);
  } finally {
    for (const b of yearButtons.querySelectorAll("button")) b.disabled = false;
  }
}

async function loadYear(year) {
  if (activitiesCache.has(year)) return activitiesCache.get(year);

  // PMC の warmup 用に 60 日前から取得 (CTL の初期値を埋める)
  const start = new Date(Date.UTC(year - 1, 10, 1));  // 11月1日前年
  const end   = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const acts = await fetchActivities({
    token,
    after:  Math.floor(start.getTime() / 1000),
    before: Math.floor(end.getTime() / 1000),
    onProgress: msg => fetchStatus.textContent = msg,
  });
  activitiesCache.set(year, acts);
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
