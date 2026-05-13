import test from "node:test";
import assert from "node:assert/strict";
import {
  tssFor, computePmc, DEFAULT_FTP,
  decayForward, hoursUntilFresh, lastActivityEndMs,
} from "../public/js/pmc.js";

test("tssFor uses suffer_score when present", () => {
  const a = { sport_type: "Ride", elapsed_time: 3600, moving_time: 3600, suffer_score: 73 };
  assert.equal(tssFor(a), 73);
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
