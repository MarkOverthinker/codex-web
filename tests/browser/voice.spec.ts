import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";

async function setupVoice(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => new MediaStream() });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: class {
      static isTypeSupported() { return true; }
      mimeType = "audio/webm";
      state = "inactive";
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() { this.state = "recording"; }
      stop() {
        if (this.state !== "recording") return;
        this.state = "inactive";
        queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["test-audio"], { type: this.mimeType }) }); this.onstop?.(); });
      }
    } });
  });
  const errors = await setup(page, false, true);
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/messages")) sent.push(request.postData() ?? "");
  });
  return { errors, sent };
}

test("desktop voice selection shares the settings row and microphone sits next to send", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { errors, sent } = await setupVoice(page);
  const controls = page.locator(".composer-actions");
  const model = controls.getByRole("button", { name: "语音", exact: true });
  await expect(model).toBeVisible();
  const modelBounds = await model.boundingBox();
  const effortBounds = await controls.getByRole("button", { name: "思考", exact: true }).boundingBox();
  expect(Math.abs(modelBounds!.y - effortBounds!.y)).toBeLessThan(3);
  const microphone = page.locator(".composer-submit-actions .mic-button");
  const micBounds = await microphone.boundingBox();
  const sendBounds = await controls.getByRole("button", { name: "发送", exact: true }).boundingBox();
  expect(sendBounds!.x - micBounds!.x - micBounds!.width).toBeLessThan(12);
  expect(Math.abs(micBounds!.y - sendBounds!.y)).toBeLessThan(3);
  await model.click();
  await expect(page.getByRole("option", { name: "SenseVoiceSmall INT8", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Fun-ASR-Nano FP32", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Qwen3-ASR-0.6B", exact: true }).click();
  await expect(model).toContainText("Qwen3-ASR-0.6B");
  await page.reload();
  await expect(model).toContainText("Qwen3-ASR-0.6B");
  if (process.env.VOICE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.VOICE_SCREENSHOT_DIR}/voice-toolbar-desktop.png` });
  expect(sent).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("stop only transcribes; chosen model and latest manually edited draft are preserved", async ({ page }) => {
  const { errors, sent } = await setupVoice(page);
  let payload = "";
  let finish!: () => void;
  await page.route("**/api/transcriptions", async (route) => {
    payload = route.request().postData() ?? "";
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ json: { text: "语音补充" } });
  });
  await page.getByRole("button", { name: "语音", exact: true }).click();
  await page.getByRole("option", { name: "Qwen3-ASR-0.6B", exact: true }).click();
  const input = page.locator(".composer textarea");
  await input.fill("原稿");
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  await expect(page.getByRole("button", { name: "语音", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "停止录音并转写", exact: true }).click();
  await expect.poll(() => payload).toContain("qwen3-asr-0.6b");
  await input.fill("识别期间修改的草稿");
  finish();
  await expect(input).toHaveValue("识别期间修改的草稿\n语音补充");
  expect(sent).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("voice punctuation and terms persist and accompany transcription", async ({ page }) => {
  await setupVoice(page);
  let payload = "";
  await page.route("**/api/transcriptions", async (route) => {
    payload = route.request().postData() ?? "";
    await route.fulfill({ json: { text: "Codex" } });
  });
  const menu = page.getByRole("button", { name: "语音", exact: true });
  await menu.click();
  await page.getByRole("option", { name: "Qwen3-ASR-0.6B", exact: true }).click();
  await menu.click();
  await page.getByLabel("语音常用术语").fill("Codex, TypeScript");
  await page.getByLabel("语音断句方式").selectOption("original");
  await page.reload();
  await menu.click();
  await expect(page.getByLabel("语音常用术语")).toHaveValue("Codex, TypeScript");
  await expect(page.getByLabel("语音断句方式")).toHaveValue("original");
  await menu.click();
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  await page.getByRole("button", { name: "停止录音并转写", exact: true }).click();
  await expect.poll(() => payload).toContain('"hotwords":["Codex","TypeScript"]');
  expect(payload).toContain('"punctuation":"original"');
});

test("Nano remains selectable and invalid terms do not block switching back to SenseVoice", async ({ page }) => {
  await setupVoice(page);
  let payload = "";
  await page.route("**/api/transcriptions", async (route) => {
    payload = route.request().postData() ?? "";
    await route.fulfill({ json: { text: "测试" } });
  });
  const menu = page.getByRole("button", { name: "语音", exact: true });
  await menu.click();
  await page.getByRole("option", { name: "Fun-ASR-Nano FP32", exact: true }).click();
  await expect(menu).toContainText("Fun-ASR-Nano FP32");
  await menu.click();
  await page.getByLabel("语音常用术语").fill("<invalid>");
  await expect(page.locator(".voice-preferences [role=alert]")).toBeVisible();
  await page.getByRole("option", { name: "SenseVoiceSmall INT8", exact: true }).click();
  await menu.click();
  await page.getByLabel("语音断句方式").selectOption("original");
  await expect(page.locator(".voice-preferences [role=alert]")).toHaveCount(0);
  await menu.click();
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  await page.getByRole("button", { name: "停止录音并转写", exact: true }).click();
  await expect.poll(() => payload).toContain('"hotwords":[]');
  expect(payload).toContain('"punctuation":"original"');
});

test("send during recording transcribes then sends exactly once with the latest draft", async ({ page }) => {
  const { errors, sent } = await setupVoice(page);
  let finish!: () => void;
  let requests = 0;
  await page.route("**/api/transcriptions", async (route) => {
    requests += 1;
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ json: { text: "语音指令" } });
  });
  const input = page.locator(".composer textarea");
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  const send = page.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeEnabled();
  await send.dblclick();
  await expect.poll(() => requests).toBe(1);
  await expect(send).toBeDisabled();
  expect(sent).toHaveLength(0);
  await input.fill("等待识别时补充");
  finish();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].replace(/\r\n/g, "\n")).toContain("等待识别时补充\n语音指令");
  await expect(input).toHaveValue("");
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
});

for (const response of [{ status: 422, json: { error: "没有识别到人声" } }, { status: 200, json: { text: "  " } }]) {
  test(`failed or empty transcription never sends a message (${response.status})`, async ({ page }) => {
    const { sent } = await setupVoice(page);
    await page.route("**/api/transcriptions", (route) => route.fulfill(response));
    const input = page.locator(".composer textarea");
    await input.fill("保留原稿");
    await page.getByRole("button", { name: "录音输入", exact: true }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".voice-error")).toBeVisible();
    await expect(input).toHaveValue("保留原稿");
    expect(sent).toHaveLength(0);
  });
}

test("canceling recognition discards the pending send intent and late response", async ({ page }) => {
  const { sent } = await setupVoice(page);
  let finish!: () => void;
  await page.route("**/api/transcriptions", async (route) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ json: { text: "不能发送" } }).catch(() => undefined);
  });
  const input = page.locator(".composer textarea");
  await input.fill("保留草稿");
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => Boolean(finish)).toBe(true);
  await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
  finish();
  await expect(page.getByRole("button", { name: "录音输入", exact: true })).toBeEnabled();
  await page.waitForTimeout(100);
  await expect(input).toHaveValue("保留草稿");
  expect(sent).toHaveLength(0);
  await page.unroute("**/api/transcriptions");
  await page.route("**/api/transcriptions", (route) => route.fulfill({ json: { text: "下一段" } }));
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  await page.getByRole("button", { name: "停止录音并转写", exact: true }).click();
  await expect(input).toHaveValue("保留草稿\n下一段");
  expect(sent).toHaveLength(0);
});

test("side chat places voice model with settings and supports stop-only and transcribe-send", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { sent, errors } = await setupVoice(page);
  await page.route("**/api/transcriptions", (route) => route.fulfill({ json: { text: "侧边语音" } }));
  await page.getByTitle("打开侧边聊天", { exact: true }).click();
  const side = page.locator(".side-chat-pane");
  await expect(side.locator(".side-chat-settings").getByRole("combobox", { name: "语音识别模型" })).toBeVisible();
  await expect(side.locator(".side-chat-composer").getByRole("combobox")).toHaveCount(0);
  await side.getByRole("button", { name: "录音输入", exact: true }).click();
  await side.getByRole("button", { name: "停止录音并转写", exact: true }).click();
  await expect(side.locator(".side-chat-composer textarea")).toHaveValue("侧边语音");
  expect(sent).toHaveLength(0);
  await side.getByRole("button", { name: "录音输入", exact: true }).click();
  await side.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].replace(/\r\n/g, "\n")).toContain("侧边语音\n侧边语音");
  await expect(side.locator(".side-chat-composer textarea")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("closing a side chat during recognition cancels its pending send", async ({ page }) => {
  const { sent } = await setupVoice(page);
  let finish!: () => void;
  await page.route("**/api/transcriptions", async (route) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ json: { text: "迟到结果" } }).catch(() => undefined);
  });
  await page.getByTitle("打开侧边聊天", { exact: true }).click();
  const side = page.locator(".side-chat-pane");
  await side.getByRole("button", { name: "录音输入", exact: true }).click();
  await side.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => Boolean(finish)).toBe(true);
  await side.getByRole("button", { name: "关闭侧边聊天", exact: true }).click();
  finish();
  await expect(side).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(sent).toHaveLength(0);
  await expect(page.locator(".composer textarea")).toHaveValue("");
});

test("a rejected send keeps the recognized draft available for retry", async ({ page }) => {
  const { sent } = await setupVoice(page);
  await page.route("**/api/transcriptions", (route) => route.fulfill({ json: { text: "保留转写" } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ status: 503, json: { error: "发送暂不可用" } }));
  await page.locator(".composer textarea").fill("原稿");
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("发送暂不可用", { exact: true })).toBeVisible();
  await expect(page.locator(".composer textarea")).toHaveValue("原稿\n保留转写");
  expect(sent).toHaveLength(1);
});

test("native pause stops to a draft rather than sending", async ({ page }) => {
  const { sent } = await setupVoice(page);
  await page.route("**/api/transcriptions", (route) => route.fulfill({ json: { text: "后台停止录音" } }));
  await page.getByRole("button", { name: "录音输入", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("codex-native-pause")));
  await expect(page.locator(".composer textarea")).toHaveValue("后台停止录音");
  expect(sent).toHaveLength(0);
});

for (const width of [360, 390, 430]) {
  test(`app ${width}px keeps one voice button; model selection lives in task options`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { errors, sent } = await setupVoice(page);
    await expect(page.locator(".composer-actions .mic-button")).toHaveCount(1);
    await expect(page.locator(".composer-actions .setting-menu.voice-model")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "语音", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "任务选项", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "任务选项", exact: true });
    await sheet.getByRole("button", { name: "语音", exact: true }).click();
    await sheet.getByRole("option", { name: "Qwen3-ASR-0.6B", exact: true }).click();
    await expect(sheet.getByRole("button", { name: "语音", exact: true })).toContainText("Qwen3-ASR-0.6B");
    if (width === 390 && process.env.VOICE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.VOICE_SCREENSHOT_DIR}/voice-app-options.png` });
    await sheet.getByRole("button", { name: "关闭任务选项", exact: true }).click();
    if (width === 390 && process.env.VOICE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.VOICE_SCREENSHOT_DIR}/voice-app-toolbar.png` });
    await page.getByRole("button", { name: "录音输入", exact: true }).click();
    await expect(page.locator(".composer-actions .mic-button")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
    expect(sent).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}
