import assert from "node:assert/strict";
import test from "node:test";
import { billingQuery, localBillingRange } from "../src/billing-range.js";

test("billing ranges include the entire local end minute and serialize all API actions consistently", () => {
  const range = localBillingRange("2026-09-01", "2026-09-01");
  assert.equal(range.from, new Date("2026-09-01T00:00:00").toISOString());
  assert.equal(range.to, new Date("2026-09-02T00:00:00").toISOString());
  const minute = localBillingRange("2026-09-01", "2026-09-01", "09:30", "09:30");
  assert.equal(Date.parse(minute.to) - Date.parse(minute.from), 60_000);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(billingQuery(range))), range);
  assert.equal(billingQuery(0), "days=0");
  assert.equal(billingQuery(30), "days=30");
});

test("billing date inputs reject missing, impossible, and reversed ranges", () => {
  for (const [start, end, startTime, endTime] of [
    ["", "2026-09-01"], ["2026-02-30", "2026-03-01"], ["2026-09-02", "2026-09-01"],
    ["2026-09-01", "2026-09-01", "12:00", "11:59"], ["2026-09-01", "2026-09-01", "25:00", "23:59"],
  ]) assert.throws(() => localBillingRange(start, end, startTime, endTime));
});

test("billing local dates respect daylight saving day lengths", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const spring = localBillingRange("2026-03-08", "2026-03-08");
    const autumn = localBillingRange("2026-11-01", "2026-11-01");
    assert.equal(Date.parse(spring.to) - Date.parse(spring.from), 23 * 3_600_000);
    assert.equal(Date.parse(autumn.to) - Date.parse(autumn.from), 25 * 3_600_000);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
