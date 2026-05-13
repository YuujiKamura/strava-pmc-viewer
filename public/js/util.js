// XSS 防御: Strava activity.name 等の user-controlled string を innerHTML に流す
// 経路で必ず escape する。5 文字 (& < > " ') を HTML entity に置換。
export const escapeHtml = s => String(s).replace(/[&<>"']/g, ch =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));

/** activity.id でユニーク化 (warmup と loadYear の重複期間を吸収)。 */
export function dedupActivities(activities) {
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

/** 時間数 → 「N 日 H 時間」or 「H 時間 M 分」or 「M 分」。
 *  Math.round で h=24 や m=60 になる繰上げを吸収する。 */
export function formatElapsed(hours) {
  if (hours < 1) {
    const m = Math.max(0, Math.round(hours * 60));
    if (m >= 60) return `1 時間`;  // 0.9999h を round で 60 分 → 1 時間に繰上げ
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
  if (h >= 24) { d += 1; h = 0; }
  return h > 0 ? `${d} 日 ${h} 時間` : `${d} 日`;
}
