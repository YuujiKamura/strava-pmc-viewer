import test from "node:test";
import assert from "node:assert/strict";
import { tssFor, computePmc, DEFAULT_FTP } from "../public/js/pmc.js";

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
