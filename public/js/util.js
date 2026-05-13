// XSS 防御: Strava activity.name 等の user-controlled string を innerHTML に流す
// 経路で必ず escape する。5 文字 (& < > " ') を HTML entity に置換。
export const escapeHtml = s => String(s).replace(/[&<>"']/g, ch =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));
