// PMC (Performance Management Chart) ── pure functions, no DOM, no fetch.
// Port of ~/strava-collector/app/services/pmc_calculator.rb.
//
// 用語:
//   TSS = Training Stress Score per day
//   CTL = 42-day EMA of TSS (Fitness)
//   ATL = 7-day  EMA of TSS (Fatigue)
//   TSB = previous day CTL - previous day ATL (Form)
//
// activity 1 件あたりの TSS 推定優先順位:
//   1. suffer_score (HR-derived Relative Effort、Strava 公式値)
//   2. weighted_average_watts による power-based TSS
//   3. moving_time × sport 別係数
//   4. elapsed_time × sport 別係数
// 上位データが無い時だけ次に落ちる。

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
  if (a.suffer_score != null && a.suffer_score > 0) return Number(a.suffer_score);

  const np = a.weighted_average_watts;
  const moving = a.moving_time;
  if (np && np > 0 && moving && moving > 0) {
    const intensityFactor = np / ftp;
    return (moving / 3600) * intensityFactor * intensityFactor * 100;
  }

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
