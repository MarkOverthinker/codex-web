import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitOnEnter } from "../src/mobile-input";

test("mobile Enter always inserts a newline instead of submitting a task", () => {
  for (const shiftKey of [false, true]) {
    for (const isComposing of [false, true]) {
      assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey, isComposing, mobile: true }), false);
    }
  }
});

test("desktop Enter submits, while Shift+Enter and IME composition do not", () => {
  const options = { key: "Enter", shiftKey: false, isComposing: false, mobile: false };
  assert.equal(shouldSubmitOnEnter(options), true);
  assert.equal(shouldSubmitOnEnter({ ...options, shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ ...options, isComposing: true }), false);
  assert.equal(shouldSubmitOnEnter({ ...options, key: "Escape" }), false);
});
