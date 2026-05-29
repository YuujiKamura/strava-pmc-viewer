import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, parsePayload } from "../public/js/config-io.js";

test("buildPayload は format/version/config/savedAt を含む JSON", () => {
  const out = buildPayload({ clientId: "234530", workerUrl: "https://w.example.dev" }, new Date("2026-05-26T00:00:00Z"));
  const obj = JSON.parse(out);
  assert.equal(obj._format, "strava-pmc-config");
  assert.equal(obj._version, 1);
  assert.equal(obj.config.clientId, "234530");
  assert.equal(obj.config.workerUrl, "https://w.example.dev");
  assert.equal(obj.savedAt, "2026-05-26T00:00:00.000Z");
});

test("buildPayload は scope 系フィールドを payload に出さない", () => {
  const out = buildPayload({ clientId: "1", workerUrl: "https://w", scopeReadAll: false });
  const cfg = JSON.parse(out).config;
  assert.equal("scopeReadAll" in cfg, false);
  assert.deepEqual(Object.keys(cfg).sort(), ["clientId", "workerUrl"]);
});

test("parsePayload は正しい payload を読める", () => {
  const text = JSON.stringify({
    _format: "strava-pmc-config", _version: 1,
    config: { clientId: "234530", workerUrl: "https://w.example.dev" },
    savedAt: "2026-05-26T00:00:00.000Z",
  });
  const r = parsePayload(text);
  assert.equal(r.ok, true);
  assert.equal(r.config.clientId, "234530");
  assert.equal(r.config.workerUrl, "https://w.example.dev");
  assert.equal("scopeReadAll" in r.config, false);
});

test("parsePayload は wrapper なしの素の config object も読める (旧版互換)", () => {
  const text = JSON.stringify({ clientId: "1", workerUrl: "https://w" });
  const r = parsePayload(text);
  assert.equal(r.ok, true);
  assert.equal(r.config.clientId, "1");
  assert.equal(r.config.workerUrl, "https://w");
});

test("parsePayload は旧版が書いた scopeReadAll を黙って捨てる", () => {
  const text = JSON.stringify({ config: { clientId: "1", workerUrl: "https://w", scopeReadAll: false } });
  const r = parsePayload(text);
  assert.equal(r.ok, true);
  assert.equal("scopeReadAll" in r.config, false);
});

test("parsePayload は壊れた JSON を rejecte", () => {
  const r = parsePayload("{not json");
  assert.equal(r.ok, false);
  assert.match(r.reason, /JSON/);
});

test("parsePayload は必須欠落を rejecte", () => {
  const r = parsePayload(JSON.stringify({ config: { clientId: "1" } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /workerUrl|clientId|不完全/);
});

test("parsePayload は前後空白を trim する", () => {
  const text = JSON.stringify({ config: { clientId: "  234530  ", workerUrl: "  https://w  " } });
  const r = parsePayload(text);
  assert.equal(r.ok, true);
  assert.equal(r.config.clientId, "234530");
  assert.equal(r.config.workerUrl, "https://w");
});
