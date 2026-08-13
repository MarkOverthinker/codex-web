import assert from "node:assert/strict";
import test from "node:test";
import { packTaskGrid } from "../src/task-grid-fill.js";

test("packTaskGrid keeps a single column when every card fits", () => {
  assert.deepEqual(packTaskGrid([100, 100, 100], 340, 320, 150, 8), {
    columns: 1,
    height: 316,
    cards: [
      { left: 0, top: 0, width: 320 },
      { left: 0, top: 108, width: 320 },
      { left: 0, top: 216, width: 320 },
    ],
  });
});

test("packTaskGrid fills the shortest column and breaks ties to the left", () => {
  assert.deepEqual(packTaskGrid([100, 100, 50, 50, 50], 100, 320, 150, 8), {
    columns: 2,
    height: 216,
    cards: [
      { left: 0, top: 0, width: 156 },
      { left: 164, top: 0, width: 156 },
      { left: 0, top: 108, width: 156 },
      { left: 164, top: 108, width: 156 },
      { left: 0, top: 166, width: 156 },
    ],
  });
});

test("packTaskGrid keeps every card in one column when the width fits one column", () => {
  assert.deepEqual(packTaskGrid([100, 100, 100, 100], 216, 300, 150, 8), {
    columns: 1,
    height: 424,
    cards: [
      { left: 0, top: 0, width: 300 },
      { left: 0, top: 108, width: 300 },
      { left: 0, top: 216, width: 300 },
      { left: 0, top: 324, width: 300 },
    ],
  });
});

test("packTaskGrid caps columns at the width and falls back to overflowing vertically", () => {
  assert.deepEqual(packTaskGrid([200, 200, 200], 100, 320, 150, 8), {
    columns: 2,
    height: 408,
    cards: [
      { left: 0, top: 0, width: 156 },
      { left: 164, top: 0, width: 156 },
      { left: 0, top: 208, width: 156 },
    ],
  });
});

test("packTaskGrid handles empty and non-positive containers", () => {
  assert.deepEqual(packTaskGrid([], 340, 320, 150, 8), { columns: 1, height: 0, cards: [] });
  assert.deepEqual(packTaskGrid([100, 100], 0, 320, 150, 8), {
    columns: 1,
    height: 208,
    cards: [
      { left: 0, top: 0, width: 320 },
      { left: 0, top: 108, width: 320 },
    ],
  });
  assert.deepEqual(packTaskGrid([100, 100], 340, 0, 150, 8), {
    columns: 1,
    height: 208,
    cards: [
      { left: 0, top: 0, width: 0 },
      { left: 0, top: 108, width: 0 },
    ],
  });
});

test("packTaskGrid accounts for gaps between cards", () => {
  assert.deepEqual(packTaskGrid([100, 100], 208, 320, 150, 8), {
    columns: 1,
    height: 208,
    cards: [
      { left: 0, top: 0, width: 320 },
      { left: 0, top: 108, width: 320 },
    ],
  });
  assert.deepEqual(packTaskGrid([100, 100], 207, 320, 150, 8), {
    columns: 2,
    height: 100,
    cards: [
      { left: 0, top: 0, width: 156 },
      { left: 164, top: 0, width: 156 },
    ],
  });
});

test("packTaskGrid widens until the packed height fits", () => {
  assert.deepEqual(packTaskGrid([200, 200, 20, 20], 220, 616, 150, 8), {
    columns: 3,
    height: 200,
    cards: [
      { left: 0, top: 0, width: 200 },
      { left: 208, top: 0, width: 200 },
      { left: 416, top: 0, width: 200 },
      { left: 416, top: 28, width: 200 },
    ],
  });
});

test("packTaskGrid packs tight before widening to more columns", () => {
  assert.deepEqual(packTaskGrid([200, 20, 20, 20, 20], 250, 500, 150, 8), {
    columns: 2,
    height: 200,
    cards: [
      { left: 0, top: 0, width: 246 },
      { left: 254, top: 0, width: 246 },
      { left: 254, top: 28, width: 246 },
      { left: 254, top: 56, width: 246 },
      { left: 254, top: 84, width: 246 },
    ],
  });
});

test("packTaskGrid clamps invalid card heights to zero", () => {
  assert.deepEqual(packTaskGrid([Number.NaN, -5, 10], 100, 320, 150, 8), {
    columns: 1,
    height: 26,
    cards: [
      { left: 0, top: 0, width: 320 },
      { left: 0, top: 8, width: 320 },
      { left: 0, top: 16, width: 320 },
    ],
  });
});
