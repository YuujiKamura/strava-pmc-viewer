// PMC (Performance Management Chart) ── pure functions, no DOM, no fetch.
// Port of ~/strava-collector/app/services/pmc_calculator.rb.
//
// 用語:
//   TSS = Training Stress Score per day
//   CTL = 42-day EMA of TSS (Fitness)
//   ATL = 7-day  EMA of TSS (Fatigue)
//   TSB = previous day CTL - previous day ATL (Form)
//
// activity 1 件あたりの TSS 推定優先順位 (Strava 公式の Fitness 算出に揃える):
//   1. weighted_average_watts による power-based TSS = NP/FTP² × duration × 100
//      ── Strava の "Training Load" と等価、公式 Fitness の第一情報源
//   2. suffer_score (HR-derived Relative Effort)
//      ── Strava 公式は本人の (RE, TL) 線形回帰 (10 ride 以上) で TL 換算するが、
//      本ツールは回帰未実装、RE をそのまま TSS 近似として採用 (= 公式より粗い)
//   3. moving_time × sport 別係数
//   4. elapsed_time × sport 別係数
// 上位データが無い時だけ次に落ちる。power → HR → 時間 × 係数 と精度が落ちる。

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

export const TSS_PER_HOUR = {
  Ride:        60,
  VirtualRide: 70,
  Run:         75,
  Hike:        35,
  Walk:        25,
  Workout:     50,
  Yoga:        25,
  Canoeing:    40,
  Windsurf:    45,
  // 日本語表記 (旧 Strava activity)
  "ライド":          60,
  "バーチャル ライド": 70,
  "ランニング":      75,
  "ハイキング":      35,
  "ウォーキング":    25,
  "ワークアウト":    50,
  "ヨガ":           25,
};
export const DEFAULT_TSS_PER_HOUR = 50;
export const DEFAULT_FTP = 200;

/**
 * @param {object} a Strava SummaryActivity or DetailedActivity
 * @param {number} ftp default 200W
 * @returns {number} estimated TSS
 */
export function tssFor(a, ftp = DEFAULT_FTP) {
  // (1) power-based TSS = Strava 公式の Training Load 算出と等価、最優先
  const np = a.weighted_average_watts;
  const moving = a.moving_time;
  if (np && np > 0 && moving && moving > 0) {
    const intensityFactor = np / ftp;
    return (moving / 3600) * intensityFactor * intensityFactor * 100;
  }

  // (2) suffer_score (Relative Effort) を TSS 近似として採用 (公式は本人回帰)
  if (a.suffer_score != null && a.suffer_score > 0) return Number(a.suffer_score);

  // (3)(4) sport 別係数 fallback (Detailed Activity 未取得時の粗推定)
  const seconds = (moving && moving > 0) ? moving : (a.elapsed_time > 0 ? a.elapsed_time : 0);
  if (seconds <= 0) return 0;
  const sportKey = a.sport_type || a.type || "";
  const rate = TSS_PER_HOUR[sportKey] ?? DEFAULT_TSS_PER_HOUR;
  return (seconds / 3600) * rate;
}

/** ISO date string (YYYY-MM-DD) from Date or ISO string */
function isoDate(d) {
  const date = (d instanceof Date) ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

/**
 * 1 日づつ EMA を進めて Point の配列を返す。
 *
 * @param {Array<object>} activities Strava activity 配列 ({start_date, sport_type, moving_time, elapsed_time, suffer_score?, weighted_average_watts?})
 * @param {{from: Date|string, to: Date|string, ftp?: number}} opts 出力 range (両端 inclusive)
 * @returns {Array<{date, tss, ctl, atl, tsb}>}
 */
export function computePmc(activities, { from, to, ftp = DEFAULT_FTP }) {
  // daily TSS map
  const daily = new Map();
  let earliest = null;
  for (const a of activities) {
    if (!a.start_date) continue;
    const d = isoDate(a.start_date);
    daily.set(d, (daily.get(d) || 0) + tssFor(a, ftp));
    if (earliest === null || d < earliest) earliest = d;
  }

  const fromStr = isoDate(from);
  const toStr   = isoDate(to);

  // warmup: 既存活動の最古から from の前日まで EMA を走らせて初期値を埋める
  let ctl = 0, atl = 0;
  if (earliest !== null && earliest < fromStr) {
    for (let d = new Date(earliest); isoDate(d) < fromStr; d.setUTCDate(d.getUTCDate() + 1)) {
      const t = daily.get(isoDate(d)) || 0;
      ctl += (t - ctl) / CTL_DAYS;
      atl += (t - atl) / ATL_DAYS;
    }
  }

  const points = [];
  for (let d = new Date(fromStr); isoDate(d) <= toStr; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = isoDate(d);
    const tsb  = ctl - atl;       // 前日値ベース
    const t    = daily.get(date) || 0;
    ctl += (t - ctl) / CTL_DAYS;
    atl += (t - atl) / ATL_DAYS;
    points.push({
      date,
      tss: round1(t),
      ctl: round1(ctl),
      atl: round1(atl),
      tsb: round1(tsb),
    });
  }
  return points;
}

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * activities の中で「最後に運動を終えた瞬間」を ms epoch で返す。
 * end = start_date + elapsed_time。これ以降は TSS = 0 区間で連続減衰させる。
 * @param {Array<object>} activities
 * @returns {number|null} ms epoch (UTC) または activity が無ければ null
 */
export function lastActivityEndMs(activities) {
  let max = 0;
  for (const a of activities) {
    if (!a.start_date) continue;
    const t = Date.parse(a.start_date);
    if (!Number.isFinite(t)) continue;
    const end = t + ((Number(a.elapsed_time) || 0) * 1000);
    if (end > max) max = end;
  }
  return max || null;
}

/**
 * 「TSS = 0 区間で hoursAhead 時間経過した時の CTL / ATL / TSB」を返す。
 * 日単位 EMA `y_{n+1} = y_n + (TSS - y_n)/N` は連続時間で
 * `dy/dt = (TSS - y)/N` (時間単位は日)、TSS=0 区間では `y(t) = y0 * exp(-t/N)`。
 * 「身体は時計の針が進むごとに回復する」を時間粒度で素直に表現する。
 *
 * @param {{ctl: number, atl: number}} prev 日単位 point (computePmc の最新点)
 * @param {number} hoursAhead 経過時間 (時間)、負なら 0 に clamp
 * @returns {{ctl: number, atl: number, tsb: number, hoursAhead: number}}
 */
export function decayForward(prev, hoursAhead) {
  const h = Math.max(0, Number(hoursAhead) || 0);
  const days = h / 24;
  const ctl = (prev.ctl || 0) * Math.exp(-days / CTL_DAYS);
  const atl = (prev.atl || 0) * Math.exp(-days / ATL_DAYS);
  // TSB は Friel convention に揃え、ここでも「現在の CTL - 現在の ATL」で簡易計算。
  // (本来の Friel は前日 CTL - 前日 ATL だが、現在時刻スナップショットでは現値で OK)
  return { ctl: round1(ctl), atl: round1(atl), tsb: round1(ctl - atl), hoursAhead: h };
}

/**
 * 「TSS = 0 のまま CTL / ATL が任意の閾値に達するまで何時間かかるか」を解析的に解く。
 * `y(t) = y0 * exp(-t/N)` を target で解いて hours を返す。
 * @param {number} y0 起点の値 (ATL or CTL)
 * @param {number} target 目標値 (例: TSB が 0 になる ATL = CTL)
 * @param {number} tauDays 7 (ATL) or 42 (CTL)
 * @returns {number|null} 時間 (時間単位)、到達不能 (y0 <= target または値が 0) なら null
 */
export function hoursUntilDecayTo(y0, target, tauDays) {
  if (!Number.isFinite(y0) || !Number.isFinite(target)) return null;
  if (y0 <= 0 || target <= 0) return null;
  if (y0 <= target) return 0;
  const days = tauDays * Math.log(y0 / target);
  return days * 24;
}

/**
 * 「TSS = 0 のまま CTL = ATL (= TSB が 0) になるまで何時間か」を解析的に。
 * 連続時間モデル: ctl0 * exp(-t/42) = atl0 * exp(-t/7) を t について解く。
 * t = (1/7 - 1/42)^-1 * ln(atl0 / ctl0) = (8.4) * ln(atl0 / ctl0) days
 * @param {{ctl: number, atl: number}} prev
 * @returns {number|null} 時間、ATL <= CTL (= TSB >= 0) なら 0、解不能なら null
 */
export function hoursUntilFresh(prev) {
  const a = Number(prev.atl), c = Number(prev.ctl);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return null;
  if (a <= 0 || c <= 0) return null;
  if (a <= c) return 0;
  // 1/7 - 1/42 = 6/42 - 1/42 = 5/42  →  days = (42/5) * ln(a/c) = 8.4 * ln(a/c)
  const days = (42 / 5) * Math.log(a / c);
  return days * 24;
}
