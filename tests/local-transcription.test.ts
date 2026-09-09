import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { AVAILABLE_LOCAL_VOICE_MODELS, LOCAL_VOICE_MODELS, transcribeLocally } from "../server/local-transcription.js";
import { TranscriptionService } from "../server/transcription.js";
import { appendVoiceTranscript, validVoiceModel } from "../src/voice-input-state.js";
import { hotwordsFromText, parseVoiceOptions } from "../src/voice-options.js";

test("voice options reject oversized or unsafe hints without silently rewriting them", () => {
  assert.deepEqual(parseVoiceOptions({}), { hotwords: [], punctuation: "smart" });
  assert.deepEqual(hotwordsFromText("Codex， TypeScript\nFastAPI"), ["Codex", "TypeScript", "FastAPI"]);
  assert.deepEqual(parseVoiceOptions({ hotwords: [" Codex ", "Codex"] }).hotwords, ["Codex"]);
  for (const value of [{ hotwords: ["a".repeat(41)] }, { hotwords: ["<system>"] }, { hotwords: Array(21).fill("a") }, { punctuation: "rewrite" }, { url: "remote" }]) {
    assert.throws(() => parseVoiceOptions(value));
  }
});

test("optional Nano extends the model list without replacing either existing model", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-local-models-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ dataRoot: root, transcriptionProvider: "local", localAsrModels: AVAILABLE_LOCAL_VOICE_MODELS.map((model) => model.id) });
  const service = new TranscriptionService(config);
  assert.deepEqual(service.models, AVAILABLE_LOCAL_VOICE_MODELS);
  assert.deepEqual(service.models.slice(0, 2), LOCAL_VOICE_MODELS);
});

test("invalid explicit transcription configuration never enables cloud processing", () => {
  const original = process.env.TRANSCRIPTION_PROVIDER;
  try {
    process.env.TRANSCRIPTION_PROVIDER = "locla";
    assert.equal(loadConfig().transcriptionProvider, "disabled");
    process.env.TRANSCRIPTION_PROVIDER = "local";
    assert.equal(loadConfig().transcriptionProvider, "local");
    delete process.env.TRANSCRIPTION_PROVIDER;
    assert.equal(loadConfig().transcriptionProvider, "dashscope");
  } finally {
    if (original === undefined) delete process.env.TRANSCRIPTION_PROVIDER;
    else process.env.TRANSCRIPTION_PROVIDER = original;
  }
});

test("voice choices reject stale values and transcripts preserve the current draft", () => {
  assert.equal(validVoiceModel("qwen3-asr-0.6b", LOCAL_VOICE_MODELS), "qwen3-asr-0.6b");
  assert.equal(validVoiceModel("unknown", LOCAL_VOICE_MODELS), "sensevoice-small-int8");
  assert.equal(validVoiceModel(null, []), "");
  assert.equal(appendVoiceTranscript("手动输入", "  语音补充  "), "手动输入\n语音补充");
  assert.equal(appendVoiceTranscript("原稿\n", "补充"), "原稿\n补充");
  assert.equal(appendVoiceTranscript("原稿", "  "), "原稿");
});

test("composer retains its editable textarea and only sends voice after explicit send intent", () => {
  const source = fs.readFileSync("src/App.tsx", "utf8");
  const composer = source.slice(source.indexOf("function Composer({"), source.indexOf("function PresetMenu("));
  assert.match(composer, /<textarea ref=\{textareaRef\} defaultValue=\{input\}/);
  assert.match(composer, /appendVoiceTranscript\(inputRef.current, text\)/);
  assert.match(composer, /if \(send\) onSend\(combined\)/);
  assert.match(composer, /voice\.phase === "recording"\) voice\.stop\(true\)/);
});

test("local provider routes both models through a socket without sending context or using cloud credentials", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-local-asr-"));
  const socket = path.join("/tmp", `cww-asr-${crypto.randomUUID()}.sock`);
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url!);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-audio-extension"], "webm");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      assert.equal(Buffer.concat(chunks).toString(), "encoded-audio");
      res.end(JSON.stringify({ text: "离线识别" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  context.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const config = loadConfig({ dataRoot: root, transcriptionProvider: "local", localAsrModels: LOCAL_VOICE_MODELS.map((model) => model.id), localAsrSocket: socket, dashscopeApiKey: "", publicBaseUrl: "" });
  const service = new TranscriptionService(config, (() => { throw new Error("No cloud fallback permitted"); }) as typeof fetch);
  assert.deepEqual(service.models, LOCAL_VOICE_MODELS);
  const file = `${crypto.randomUUID()}.webm`;
  fs.writeFileSync(path.join(service.audioRoot, file), "encoded-audio");
  for (const model of LOCAL_VOICE_MODELS) assert.equal(await service.transcribe(file, { draftText: "private draft", attachmentNames: ["private.txt"] }, model.id), "离线识别");
  assert.deepEqual(calls, LOCAL_VOICE_MODELS.map((model) => `/transcribe/${model.id}`));
  await assert.rejects(service.transcribe(file, {}, "https://remote.invalid"), { status: 400 });
  await assert.rejects(service.transcribe("../../private.wav"), { status: 400 });
});

test("local client handles empty text, overload, invalid replies and a total deadline", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-local-errors-"));
  const socket = path.join("/tmp", `cww-asr-${crypto.randomUUID()}.sock`);
  const audio = path.join(root, "audio.wav");
  fs.writeFileSync(audio, "audio");
  let mode = "empty";
  const server = http.createServer((req, res) => {
    req.resume();
    if (mode === "timeout") return;
    if (mode === "busy") { res.statusCode = 429; res.end(JSON.stringify({ error: "busy" })); }
    else if (mode === "invalid") res.end("not json");
    else res.end(JSON.stringify({ text: " " }));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [next, status] of [["empty", 422], ["busy", 429], ["invalid", 502], ["timeout", 504]] as const) {
    mode = next;
    await assert.rejects(transcribeLocally(socket, audio, LOCAL_VOICE_MODELS[0].id, 100), { status });
  }
  await assert.rejects(transcribeLocally(path.join("/tmp", `cww-missing-${crypto.randomUUID()}.sock`), audio, LOCAL_VOICE_MODELS[0].id, 100), { status: 503 });
  await assert.rejects(transcribeLocally("/" + "a".repeat(108), audio, LOCAL_VOICE_MODELS[0].id, 100), { status: 503 });
});

test("authenticated transcription API exposes local models, enforces CSRF/ownership and deletes uploaded audio", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-local-route-"));
  const socket = path.join("/tmp", `cww-asr-${crypto.randomUUID()}.sock`);
  const calls: string[] = [];
  const receivedOptions: unknown[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url!);
    receivedOptions.push(JSON.parse(Buffer.from(String(req.headers["x-asr-options"]), "base64").toString("utf8")));
    req.resume(); req.on("end", () => res.end(JSON.stringify({ text: "回填草稿，不发送" })));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const instance = createApp({ projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Local-Voice-Test!", 4), sessionSecret: "local-voice-session-secret-longer-than-thirty-two",
    hostMode: false, containerized: false, tenantWorkerIsolation: false, transcriptionProvider: "local", localAsrModels: LOCAL_VOICE_MODELS.map((model) => model.id), localAsrSocket: socket, dashscopeApiKey: "", publicBaseUrl: "" });
  context.after(async () => { instance.db.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const endpoint = "/codex-web/api/transcriptions";
  await request(instance.app).post(endpoint).attach("audio", Buffer.from("test"), { filename: "recording.webm", contentType: "audio/webm" }).expect(401);
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Local-Voice-Test!" }).expect(200);
  assert.equal(login.body.voiceEnabled, true);
  assert.deepEqual(login.body.voiceModels, LOCAL_VOICE_MODELS);
  const csrf = login.body.csrfToken;
  await agent.post(endpoint).attach("audio", Buffer.from("test"), { filename: "recording.webm", contentType: "audio/webm" }).expect(403);
  await agent.post(endpoint).set("X-CSRF-Token", csrf).field("conversationId", "inaccessible-conversation").attach("audio", Buffer.from("test"), { filename: "recording.webm", contentType: "audio/webm" }).expect(404);
  for (const model of LOCAL_VOICE_MODELS) {
    const result = await agent.post(endpoint).set("X-CSRF-Token", csrf).field("conversationId", "").field("draftText", "private draft")
      .field("attachmentNames", "[]").field("model", model.id).field("options", JSON.stringify({ hotwords: ["FastAPI"], punctuation: "original" })).attach("audio", Buffer.from("test"), { filename: "recording.webm", contentType: "audio/webm" }).expect(200);
    assert.equal(result.body.text, "回填草稿，不发送");
  }
  await agent.post(endpoint).set("X-CSRF-Token", csrf).field("model", "unknown").attach("audio", Buffer.from("test"), { filename: "recording.webm", contentType: "audio/webm" }).expect(400);
  await agent.post(endpoint).set("X-CSRF-Token", csrf).field("options", "not-json").attach("audio", Buffer.from("test"), { filename: "recording.webm", contentType: "audio/webm" }).expect(400);
  await agent.post(endpoint).set("X-CSRF-Token", csrf).field("options", JSON.stringify({ hotwords: ["<system>"] })).attach("audio", Buffer.from("test"), { filename: "recording.webm", contentType: "audio/webm" }).expect(400);
  assert.deepEqual(calls, LOCAL_VOICE_MODELS.map((model) => `/transcribe/${model.id}`));
  assert.deepEqual(receivedOptions, LOCAL_VOICE_MODELS.map(() => ({ hotwords: ["FastAPI"], punctuation: "original" })));
  assert.deepEqual(fs.readdirSync(path.join(root, "data", "voice-input")), []);
  await agent.get(`/codex-web/api/transcription-audio/${crypto.randomUUID()}.wav`).expect(404);
});
