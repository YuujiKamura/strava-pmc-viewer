// 年度別 activities キャッシュ ── localStorage、athlete ごと分離。
// 容量: 1 年 ~150件 × ~1KB = 150KB、8 年で 1.2MB (localStorage 5-10MB 上限内)。
// 1 user の本人デバイス内のみで保持、ToS §5.1 範囲内。

const VERSION = "v1";

function key(athleteId, year) {
  return `acts_${VERSION}_${athleteId || "anon"}_${year}`;
}

/** @returns {{activities: Array, fetchedAt: number} | null} */
export function loadYearCache(athleteId, year) {
  try {
    const raw = localStorage.getItem(key(athleteId, year));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.activities)) return null;
    return obj;
  } catch { return null; }
}

export function saveYearCache(athleteId, year, activities) {
  try {
    localStorage.setItem(key(athleteId, year), JSON.stringify({
      activities,
      fetchedAt: Date.now(),
    }));
    return true;
  } catch (e) {
    console.warn("cache save failed (quota?):", e);
    return false;
  }
}

export function clearYearCache(athleteId, year) {
  localStorage.removeItem(key(athleteId, year));
}

/** athleteId の全年度をクリア (logout 等) */
export function clearAllForAthlete(athleteId) {
  const prefix = `acts_${VERSION}_${athleteId || "anon"}_`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) localStorage.removeItem(k);
  }
}

/** どの年度をキャッシュ済みか */
export function cachedYears(athleteId) {
  const prefix = `acts_${VERSION}_${athleteId || "anon"}_`;
  const years = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) {
      const y = Number(k.slice(prefix.length));
      if (Number.isFinite(y)) years.push(y);
    }
  }
  return years.sort((a, b) => b - a);
}

export function fetchedAtLabel(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const Y = d.getFullYear(), M = d.getMonth() + 1, D = d.getDate();
  const h = String(d.getHours()).padStart(2, "0"), m = String(d.getMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}`;
}
