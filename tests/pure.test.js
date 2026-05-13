// pure 関数の境界 test。Round 5 audit で「test 0 で landed した pure 関数群」
// として flag された:
//   - util.dedupActivities (id 重複排除、warmup merge 正当性)
//   - util.formatElapsed (60分/24h 繰上げ、直前 commit のバグ修正点 regression)
//   - strava.pruneApiCallLog (24h cutoff)
//   - worker.parsePair (rate header 欠落時の境界)

import test from "node:test";
import assert from "node:assert/strict";
import { dedupActivities, formatElapsed } from "../public/js/util.js";
import { pruneApiCallLog } from "../public/js/strava.js";
import { parsePair } from "../worker/index.js";

// ── dedupActivities ──────────────────────────────────────────
test("dedupActivities: 同一 id は 1 件だけ残す (先勝ち)", () => {
  const acts = [
    { id: 1, name: "first" },
    { id: 2, name: "second" },
    { id: 1, name: "dup of 1" },
  ];
  const out = dedupActivities(acts);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "first");  // 先勝ち
});

test("dedupActivities: id 欠落 activity は重複扱いしない (全部残す)", () => {
  const out = dedupActivities([{ name: "a" }, { name: "b" }]);
  assert.equal(out.length, 2);
});

test("dedupActivities: null/undefined 要素も落とさず通す", () => {
  const out = dedupActivities([{ id: 1 }, null, undefined, { id: 1 }]);
  assert.equal(out.length, 3);  // {id:1} / null / undefined (2回目の id:1 は dup)
});

test("dedupActivities: 空配列", () => {
  assert.deepEqual(dedupActivities([]), []);
});

// ── formatElapsed ────────────────────────────────────────────
test("formatElapsed: <1h は 分", () => {
  assert.equal(formatElapsed(0), "0 分");
  assert.equal(formatElapsed(0.5), "30 分");
  assert.equal(formatElapsed(0.99), "59 分");  // round で 60 分にならない
});

test("formatElapsed: 60 分繰上げで 1 時間に", () => {
  // h=0.999 → 60分 → 1 時間に繰上げ (m>=60 path)
  assert.equal(formatElapsed(0.9999), "1 時間");
});

test("formatElapsed: <24h は 時間 / 時間 分", () => {
  assert.equal(formatElapsed(1), "1 時間");
  assert.equal(formatElapsed(1.5), "1 時間 30 分");
  assert.equal(formatElapsed(23), "23 時間");
  assert.equal(formatElapsed(23.5), "23 時間 30 分");
});

test("formatElapsed: 24h 直前で 1 日に繰上げ", () => {
  // 23h59分台で round して h=24 になるケース
  assert.equal(formatElapsed(23.999), "1 日");
});

test("formatElapsed: N 日 H 時間 (round 後 h=24 → 日繰上げ)", () => {
  // 7.99 日 = 191.76h、Math.floor(191.76/24)=7 d, Round(191.76-168)=24 h
  // 旧版だと「7 日 24 時間」になっていたバグ、新版で「8 日」へ繰上げ
  assert.equal(formatElapsed(7 * 24 + 23.9), "8 日");
  assert.equal(formatElapsed(7 * 24 + 12), "7 日 12 時間");
});

test("formatElapsed: 「N 日 24 時間」表記の再発 0 件 (regression pin)", () => {
  // 192h 直前を多角的に投げて 24 が出ないことを確認
  for (let h = 191.0; h < 192.5; h += 0.05) {
    const s = formatElapsed(h);
    assert.ok(!/24 時間/.test(s), `「24 時間」表記が出た: ${h}h → ${s}`);
  }
});

// ── pruneApiCallLog ──────────────────────────────────────────
test("pruneApiCallLog: 24h より古い entry を捨てる", () => {
  const now = 1_000_000_000_000;  // arbitrary epoch
  const log = [now - 86400001, now - 86400000, now - 100, now];
  pruneApiCallLog(log, now);
  // cutoff = now - 86400000、「< cutoff」を shift で捨てる → 86400000 は残る
  assert.deepEqual(log, [now - 86400000, now - 100, now]);
});

test("pruneApiCallLog: 全部古ければ空配列", () => {
  const now = 1_000_000_000_000;
  const log = [1, 2, 3];
  pruneApiCallLog(log, now);
  assert.deepEqual(log, []);
});

test("pruneApiCallLog: 空配列 / 全部新しい", () => {
  pruneApiCallLog([], Date.now());  // no throw
  const now = Date.now();
  const log = [now - 100, now];
  const before = [...log];
  pruneApiCallLog(log, now);
  assert.deepEqual(log, before);
});

test("pruneApiCallLog: window を 15min に絞ったケース", () => {
  const now = 1_000_000_000_000;
  const log = [now - 900001, now - 900000, now - 100];
  pruneApiCallLog(log, now, 900000);  // 15 min window
  assert.deepEqual(log, [now - 900000, now - 100]);
});

// ── parsePair (Worker) ───────────────────────────────────────
test("parsePair: 正常 '100,1000' → {fifteen:100, daily:1000}", () => {
  assert.deepEqual(parsePair("100,1000"), { fifteen: 100, daily: 1000 });
});

test("parsePair: 単一値 '100' → daily=0", () => {
  assert.deepEqual(parsePair("100"), { fifteen: 100, daily: 0 });
});

test("parsePair: 空文字 / null → null", () => {
  assert.equal(parsePair(""), null);
  assert.equal(parsePair(null), null);
  assert.equal(parsePair(undefined), null);
});

test("parsePair: 非数値先頭 → null", () => {
  assert.equal(parsePair("foo,bar"), null);
});

test("parsePair: 後半が非数値なら daily=0 に fallback", () => {
  assert.deepEqual(parsePair("100,foo"), { fifteen: 100, daily: 0 });
});

test("parsePair: 空白混じり (Strava 仕様 'X, Y') もパース", () => {
  // parseInt は先頭空白許容
  assert.deepEqual(parsePair("100, 1000"), { fifteen: 100, daily: 1000 });
});
