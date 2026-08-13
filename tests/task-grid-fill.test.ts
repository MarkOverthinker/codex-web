import assert from "node:assert/strict";
import test from "node:test";
import { packTaskGrid } from "../src/task-grid-fill.js";

test("packTaskGrid keeps a single column when every card fits", () => {
  assert.deepEqual(packTaskGrid([100, 100, 100], 340, 320, 150, 8), { columns: 1, rows: 3 });
});

test("packTaskGrid wraps to another column when the first is full", () => {
  assert.deepEqual(packTaskGrid([100, 100, 100, 100], 216, 320, 150, 8), { columns: 2, rows: 2 });
});

test("packTaskGrid keeps every card in one column when the width fits one column", () => {
  assert.deepEqual(packTaskGrid([100, 100, 100, 100], 216, 300, 150, 8), { columns: 1, rows: 4 });
});

test("packTaskGrid caps columns at the width and falls back to overflowing vertically", () => {
  assert.deepEqual(packTaskGrid([200, 200, 200], 100, 320, 150, 8), { columns: 2, rows: 2 });
});

test("packTaskGrid handles empty and non-positive containers", () => {
  assert.deepEqual(packTaskGrid([], 340, 320, 150, 8), { columns: 1, rows: 0 });
  assert.deepEqual(packTaskGrid([100, 100], 0, 320, 150, 8), { columns: 1, rows: 2 });
  assert.deepEqual(packTaskGrid([100, 100], 340, 0, 150, 8), { columns: 1, rows: 2 });
});

test("packTaskGrid accounts for gaps between cards", () => {
  assert.deepEqual(packTaskGrid([100, 100], 208, 320, 150, 8), { columns: 1, rows: 2 });
  assert.deepEqual(packTaskGrid([100, 100], 207, 320, 150, 8), { columns: 2, rows: 1 });
});

test("packTaskGrid computes rows with row-major heights", () => {
  assert.deepEqual(packTaskGrid([80, 120, 100, 60], 250, 320, 150, 8), { columns: 2, rows: 2 });
  assert.deepEqual(packTaskGrid([200, 20, 20, 20, 20], 250, 500, 150, 8), { columns: 3, rows: 2 });
});
