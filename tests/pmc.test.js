import test from "node:test";
import assert from "node:assert/strict";
import {
  tssFor, computePmc, DEFAULT_FTP,
  decayForward, hoursUntilFresh, lastActivityEndMs,
  activityDate, latestActivityDate, groupActivitiesByDate,
} from "../public/js/pmc.js";

test("tssFor uses suffer_score when present (and no power data)", () => {
  // power なし、suffer_score (Relative Effort) で fallback
  const a = { sport_type: "Ride", elapsed_time: 3600, moving_time: 3600, suffer_score: 73 };
  assert.equal(tssFor(a), 73);
});

test("tssFor prefers power-based TSS over suffer_score (= Strava 公式と同じ優先順位)", () => {
  // NP=200 (= FTP) → TSS=100、suffer_score=200 でも power 優先で 100
  // Strava 公式 Fitness は Training Load (power-based) を最優先、Relative Effort は
  // 二次。本ツールも 2026-05 から同じ優先順位に揃えた
  const a = { sport_type: "Ride", moving_time: 3600,
              weighted_average_watts: 200, suffer_score: 200 };
  assert.equal(Math.round(tssFor(a)), 100);
});

test("tssFor uses power-based TSS when NP available", () => {
  // 1h @ NP=200 (= FTP) → TSS=100
  const a = { sport_type: "Ride", moving_time: 3600, weighted_average_watts: 200 };
  assert.equal(Math.round(tssFor(a)), 100);
});

test("tssFor power-based scales with intensity squared", () => {
  // 1h @ NP=100 (FTP=200, IF=0.5) → TSS=25
  const a = { sport_type: "Ride", moving_time: 3600, weighted_average_watts: 100 };
  assert.equal(Math.round(tssFor(a)), 25);
});

test("tssFor falls back to moving_time × sport factor", () => {
  // 1h Ride @ 60 TSS/hr
  const a = { sport_type: "Ride", moving_time: 3600 };
  assert.equal(Math.round(tssFor(a)), 60);
});

test("tssFor falls back to elapsed_time when moving_time absent", () => {
  const a = { sport_type: "Ride", elapsed_time: 1800 };
  assert.equal(Math.round(tssFor(a)), 30);
});

test("tssFor handles Japanese sport names", () => {
  const a = { sport_type: "ライド", moving_time: 7200 };
  assert.equal(Math.round(tssFor(a)), 120);
});

test("tssFor returns 0 for empty input", () => {
  assert.equal(tssFor({}), 0);
  assert.equal(tssFor({ sport_type: "Ride" }), 0);
});

test("computePmc returns one point per day in range", () => {
  const pts = computePmc([], { from: "2026-01-01", to: "2026-01-07" });
  assert.equal(pts.length, 7);
  assert.equal(pts[0].date, "2026-01-01");
  assert.equal(pts[6].date, "2026-01-07");
});

test("computePmc: no activity → CTL/ATL stay 0", () => {
  const pts = computePmc([], { from: "2026-01-01", to: "2026-01-10" });
  for (const p of pts) {
    assert.equal(p.tss, 0);
    assert.equal(p.ctl, 0);
    assert.equal(p.atl, 0);
    assert.equal(p.tsb, 0);
  }
});

test("computePmc: CTL/ATL converge toward sustained TSS", () => {
  // 200 日連続 50 TSS の Ride (50 min)
  const acts = [];
  for (let i = 0; i < 200; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    acts.push({ sport_type: "Ride", moving_time: 3000, start_date: d.toISOString() });
  }
  const pts = computePmc(acts, { from: "2026-07-01", to: "2026-07-01" });
  assert.ok(Math.abs(pts[0].ctl - 50) < 1, `CTL ${pts[0].ctl} should approach 50`);
  assert.ok(Math.abs(pts[0].atl - 50) < 1, `ATL ${pts[0].atl} should approach 50`);
  assert.ok(Math.abs(pts[0].tsb) < 1, `TSB ${pts[0].tsb} should be near 0`);
});

test("computePmc: hard week pushes TSB negative", () => {
  const acts = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.UTC(2026, 0, i));
    acts.push({ sport_type: "Ride", moving_time: 6000, start_date: d.toISOString() }); // 100 TSS each
  }
  const pts = computePmc(acts, { from: "2026-01-08", to: "2026-01-22" });
  const afterHard = pts.find(p => p.date === "2026-01-08");
  const afterRest = pts.find(p => p.date === "2026-01-22");
  assert.ok(afterHard.tsb < 0, `TSB right after hard block should be negative: ${afterHard.tsb}`);
  assert.ok(afterRest.tsb > afterHard.tsb, `TSB should rise during rest`);
});

// ── 時間粒度の連続時間減衰 (R5: 「最後の記録時刻からの起算」) ─────
test("decayForward: hoursAhead=0 → 値が変わらない", () => {
  const r = decayForward({ ctl: 50, atl: 70 }, 0);
  assert.equal(r.ctl, 50);
  assert.equal(r.atl, 70);
  assert.equal(r.tsb, -20);
  assert.equal(r.hoursAhead, 0);
});

test("decayForward: 24時間 → ATL ≈ y0 * exp(-1/7)", () => {
  const r = decayForward({ ctl: 50, atl: 70 }, 24);
  const expectedAtl = 70 * Math.exp(-1 / 7);
  assert.ok(Math.abs(r.atl - expectedAtl) < 0.2, `ATL after 24h ≈ ${expectedAtl}, got ${r.atl}`);
  // CTL も同様に exp(-1/42)、ATL より遥かに遅い減衰
  const expectedCtl = 50 * Math.exp(-1 / 42);
  assert.ok(Math.abs(r.ctl - expectedCtl) < 0.2, `CTL after 24h ≈ ${expectedCtl}, got ${r.ctl}`);
  assert.ok(r.tsb > -20, "TSB は ATL の早い減衰で上がる");
});

test("decayForward: 負の hoursAhead は 0 clamp", () => {
  const r = decayForward({ ctl: 50, atl: 70 }, -5);
  assert.equal(r.hoursAhead, 0);
  assert.equal(r.atl, 70);
});

test("hoursUntilFresh: ATL <= CTL なら即 0", () => {
  assert.equal(hoursUntilFresh({ ctl: 50, atl: 30 }), 0);
  assert.equal(hoursUntilFresh({ ctl: 50, atl: 50 }), 0);
});

test("hoursUntilFresh: ATL > CTL なら正の時間、解析解と一致", () => {
  // ATL=70, CTL=50 → days = 8.4 * ln(70/50) = 8.4 * 0.3365 ≈ 2.83 days ≈ 67.8h
  const h = hoursUntilFresh({ ctl: 50, atl: 70 });
  assert.ok(h > 60 && h < 75, `2.83 day ≈ 67.8h、got ${h}`);
});

test("hoursUntilFresh: 0 値は null", () => {
  assert.equal(hoursUntilFresh({ ctl: 0, atl: 50 }), null);
  assert.equal(hoursUntilFresh({ ctl: 50, atl: 0 }), null);
});

test("computePmc: 朝の JST ライドは UTC 前日でなく当日 (start_date_local 採用) に bin される", () => {
  // 07:00 JST 2026-05-29 start は UTC で 22:00 2026-05-28、
  // 旧実装 (start_date を UTC slice) は 5/28 bin、 修正後は start_date_local の "2026-05-29" bin。
  // TZ 非依存のテスト ── host が UTC でも JST でも結果一致。
  const acts = [{
    sport_type: "Ride", moving_time: 3600,
    start_date:       "2026-05-28T22:00:00Z",
    start_date_local: "2026-05-29T07:00:00Z",  // 末尾 Z は Strava 仕様の嘘、実体は local 時刻
  }];
  const pts = computePmc(acts, { from: "2026-05-28", to: "2026-05-30" });
  const may28 = pts.find(p => p.date === "2026-05-28");
  const may29 = pts.find(p => p.date === "2026-05-29");
  assert.equal(may28.tss, 0, "5/28 はライド無し");
  assert.ok(may29.tss > 0, `5/29 にライドが bin される (got ${may29.tss})`);
});

test("computePmc: start_date_local 欠落時は start_date に fallback (旧 cache 互換)", () => {
  const acts = [{
    sport_type: "Ride", moving_time: 3600,
    start_date: "2026-05-29T12:00:00Z",  // 旧 cache (start_date_local 無し)
  }];
  const pts = computePmc(acts, { from: "2026-05-29", to: "2026-05-29" });
  assert.ok(pts[0].tss > 0, "start_date のみでも bin される");
});

test("lastActivityEndMs: 最終 activity の start_date + elapsed_time を返す", () => {
  const acts = [
    { start_date: "2026-05-13T10:00:00Z", elapsed_time: 3600 }, // ends 11:00
    { start_date: "2026-05-13T08:00:00Z", elapsed_time: 1800 }, // ends 08:30
    { start_date: "2026-05-12T22:00:00Z", elapsed_time: 7200 }, // ends next day 00:00
  ];
  const end = lastActivityEndMs(acts);
  assert.equal(end, Date.parse("2026-05-13T11:00:00Z"));
});

test("lastActivityEndMs: 空配列 / start_date 欠落 → null", () => {
  assert.equal(lastActivityEndMs([]), null);
  assert.equal(lastActivityEndMs([{ elapsed_time: 3600 }]), null);
});

// ── activityDate / latestActivityDate / groupActivitiesByDate (SoT) ─────
test("activityDate: start_date_local 優先 (= 朝の JST ライドは当日 bin)", () => {
  const a = {
    start_date:       "2026-05-28T22:00:00Z",
    start_date_local: "2026-05-29T07:00:00Z",
  };
  assert.equal(activityDate(a), "2026-05-29");
});

test("activityDate: start_date_local 欠落時は start_date に fallback (旧 cache 互換)", () => {
  const a = { start_date: "2026-05-29T12:00:00Z" };
  assert.equal(activityDate(a), "2026-05-29");
});

test("activityDate: start_date_local が空文字列なら start_date に fallback", () => {
  const a = { start_date_local: "", start_date: "2026-05-29T12:00:00Z" };
  assert.equal(activityDate(a), "2026-05-29");
});

test("activityDate: 両方欠落なら empty string", () => {
  assert.equal(activityDate({}), "");
  assert.equal(activityDate({ moving_time: 3600 }), "");
});

test("latestActivityDate: 最も新しい bin 日付を返す (start_date_local 優先)", () => {
  const acts = [
    { start_date_local: "2026-05-20T10:00:00Z" },
    { start_date_local: "2026-05-29T07:00:00Z", start_date: "2026-05-28T22:00:00Z" }, // 朝 JST → 5/29
    { start_date_local: "2026-05-25T15:00:00Z" },
  ];
  assert.equal(latestActivityDate(acts), "2026-05-29");
});

test("latestActivityDate: 空配列なら empty string", () => {
  assert.equal(latestActivityDate([]), "");
});

test("groupActivitiesByDate: 朝の JST ライドが当日 key に group される (= byDate と PMC bin の整合)", () => {
  const morningRide = {
    id: 1, name: "朝ライド", sport_type: "Ride",
    distance: 30000, elapsed_time: 3600, moving_time: 3300,
    start_date:       "2026-05-28T22:00:00Z",
    start_date_local: "2026-05-29T07:00:00Z",
  };
  const map = groupActivitiesByDate([morningRide]);
  assert.equal(map.has("2026-05-28"), false, "UTC slice の 5/28 には入らない");
  assert.ok(map.has("2026-05-29"), "local 採用の 5/29 に bin");
  const entry = map.get("2026-05-29")[0];
  assert.equal(entry.id, 1);
  assert.equal(entry.name, "朝ライド");
  assert.equal(entry.sport, "Ride");
  assert.equal(entry.km, 30);          // 30000 m → 30.0 km
  assert.equal(entry.min, 60);         // 3600 s → 60 分
  assert.equal(entry.movingMin, 55);   // 3300 s → 55 分
});

test("groupActivitiesByDate: 同日に複数 activity は配列で並ぶ", () => {
  const acts = [
    { id: 1, start_date_local: "2026-05-29T07:00:00Z", sport_type: "Ride", moving_time: 3000 },
    { id: 2, start_date_local: "2026-05-29T18:00:00Z", sport_type: "Run", moving_time: 1800 },
  ];
  const map = groupActivitiesByDate(acts);
  assert.equal(map.get("2026-05-29").length, 2);
  assert.deepEqual(map.get("2026-05-29").map(e => e.id), [1, 2]);
});

test("groupActivitiesByDate: start_date / start_date_local 両方欠落の activity は除外", () => {
  const acts = [
    { id: 1, start_date_local: "2026-05-29T07:00:00Z", sport_type: "Ride" },
    { id: 2, sport_type: "Ride" }, // 両方欠落 → skip
  ];
  const map = groupActivitiesByDate(acts);
  assert.equal(map.size, 1);
  assert.equal(map.get("2026-05-29").length, 1);
});
