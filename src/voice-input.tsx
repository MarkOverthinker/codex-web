import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { api, type VoiceModelOption } from "./api";
import { validVoiceModel } from "./voice-input-state";
import { hotwordsFromText, parseVoiceOptions, type VoiceOptions } from "./voice-options";

type Phase = "idle" | "requesting" | "recording" | "transcribing";

export function useVoiceInput({ models, preferenceKey, scopeKey, conversationId, disabled, draftText = "", attachmentNames = [], onTranscript }: {
  models: VoiceModelOption[];
  preferenceKey: string;
  scopeKey: string;
  conversationId?: string;
  disabled: boolean;
  draftText?: string;
  attachmentNames?: string[];
  onTranscript: (text: string, send: boolean) => void;
}) {
  const storageKey = `codex-web:voice-model:${preferenceKey}`;
  const [selected, setSelected] = useState(() => {
    try { return validVoiceModel(localStorage.getItem(storageKey), models); }
    catch { return validVoiceModel(null, models); }
  });
  const model = validVoiceModel(selected, models);
  const preferencesKey = `${storageKey}:options`;
  const [preferences, setPreferences] = useState<VoiceOptions>(() => {
    try { return parseVoiceOptions(JSON.parse(localStorage.getItem(preferencesKey) ?? "{}")); }
    catch { return parseVoiceOptions({}); }
  });
  const [hotwordText, setHotwordText] = useState(() => preferences.hotwords.join(", "));
  const [optionsError, setOptionsError] = useState("");
  const local = models.find((option) => option.id === model)?.local ?? false;
  const supportsHotwords = local && model !== "sensevoice-small-int8";
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const phaseRef = useRef<Phase>("idle");
  const generation = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const media = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<number | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const limit = useRef<number | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  const sendAfterRecognition = useRef(false);
  const callbacks = useRef({ onTranscript });
  callbacks.current = { onTranscript };

  function transition(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function release() {
    window.clearInterval(timer.current);
    window.clearTimeout(limit.current);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    media.current?.getTracks().forEach((track) => track.stop());
    media.current = null;
    void audioContext.current?.close().catch(() => undefined);
    audioContext.current = null;
  }

  function cancel() {
    generation.current += 1;
    sendAfterRecognition.current = false;
    controller.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
    release();
    transition("idle");
  }

  useLayoutEffect(() => {
    transition("idle");
    setError("");
    return () => {
      generation.current += 1;
      sendAfterRecognition.current = false;
      controller.current?.abort();
      if (recorder.current?.state === "recording") recorder.current.stop();
      release();
    };
  }, [scopeKey, models.length > 0]);

  useEffect(() => {
    try { setSelected(validVoiceModel(localStorage.getItem(storageKey), models)); }
    catch { setSelected(validVoiceModel(null, models)); }
    let next: VoiceOptions;
    try { next = parseVoiceOptions(JSON.parse(localStorage.getItem(preferencesKey) ?? "{}")); }
    catch { next = parseVoiceOptions({}); }
    setPreferences(next);
    setHotwordText(next.hotwords.join(", "));
    setOptionsError("");
  }, [storageKey]);

  function stop(send = false) {
    if (phaseRef.current !== "recording" || recorder.current?.state !== "recording") return;
    sendAfterRecognition.current = send;
    transition("transcribing");
    recorder.current.stop();
  }

  useEffect(() => {
    const pause = () => {
      if (phaseRef.current === "recording") stop();
    };
    window.addEventListener("codex-native-pause", pause);
    return () => window.removeEventListener("codex-native-pause", pause);
  }, []);

  async function start() {
    if (phaseRef.current !== "idle" || disabled || !model) return;
    setError("");
    if (supportsHotwords && optionsError) { setError(optionsError); return; }
    if (!window.isSecureContext) { setError("麦克风需要 HTTPS 或 localhost 安全环境。"); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("当前浏览器不支持录音，请使用 Chrome、Edge 或 Safari。"); return; }
    const current = ++generation.current;
    sendAfterRecognition.current = false;
    const chunks: Blob[] = [];
    const context = { conversationId, model, draftText, attachmentNames,
      ...(local ? { options: { ...preferences, hotwords: supportsHotwords ? preferences.hotwords : [] } } : {}) };
    transition("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation.current !== current) { stream.getTracks().forEach((track) => track.stop()); return; }
      media.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recording = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.current = recording;
      recording.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recording.onerror = () => { if (generation.current === current) { cancel(); setError("录音中断，请检查麦克风后重试。"); } };
      recording.onstop = async () => {
        if (generation.current !== current) return;
        release();
        recorder.current = null;
        transition("transcribing");
        const actualType = recording.mimeType || mimeType || "audio/webm";
        const extension = actualType.includes("ogg") ? "ogg" : actualType.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(chunks, { type: actualType });
        controller.current = new AbortController();
        try {
          if (!blob.size) throw new Error("没有录到声音，请重新录制。");
          const result = await api.transcribeAudio(blob, `recording.${extension}`, context, controller.current.signal);
          if (generation.current !== current) return;
          if (!result.text.trim()) throw new Error("未检测到有效人声，请重试。");
          callbacks.current.onTranscript(result.text, sendAfterRecognition.current);
        } catch (reason) {
          if (generation.current === current) setError(reason instanceof Error ? reason.message : "语音识别失败，请重试。");
        } finally {
          if (generation.current === current) transition("idle");
        }
      };
      recording.start(250);
      setSeconds(0);
      transition("recording");
      const started = Date.now();
      timer.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
      limit.current = window.setTimeout(() => stop(), 300_000);
      try {
        const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioContextClass) {
          const audio = new AudioContextClass();
          audioContext.current = audio;
          const analyser = audio.createAnalyser();
          analyser.fftSize = 128;
          audio.createMediaStreamSource(stream).connect(analyser);
          const values = new Uint8Array(analyser.frequencyBinCount);
          const draw = () => {
            if (generation.current !== current || phaseRef.current !== "recording") return;
            analyser.getByteFrequencyData(values);
            const target = canvas.current;
            const drawing = target?.getContext("2d");
            if (target && drawing) {
              drawing.clearRect(0, 0, target.width, target.height);
              drawing.fillStyle = getComputedStyle(target).color;
              values.forEach((value, index) => drawing.fillRect(index * target.width / values.length, (target.height - Math.max(2, value / 255 * target.height)) / 2, 2, Math.max(2, value / 255 * target.height)));
            }
            frame.current = requestAnimationFrame(draw);
          };
          draw();
        }
      } catch {}
    } catch (reason) {
      if (generation.current !== current) return;
      cancel();
      setError(reason instanceof DOMException && reason.name === "NotAllowedError" ? "请允许浏览器使用麦克风后重试。" : "无法开始录音，请检查麦克风。");
    }
  }

  function selectModel(value: string) {
    if (phaseRef.current !== "idle" || disabled) return;
    const next = validVoiceModel(value, models);
    setSelected(next);
    if (next === "sensevoice-small-int8" && optionsError) {
      setHotwordText(preferences.hotwords.join(", "));
      setOptionsError("");
    }
    try { localStorage.setItem(storageKey, next); } catch {}
  }

  function updatePreferences(text: string, punctuation: VoiceOptions["punctuation"]) {
    if (phaseRef.current !== "idle" || disabled) return;
    setHotwordText(text);
    try {
      const next = parseVoiceOptions({ hotwords: hotwordsFromText(text), punctuation });
      setPreferences(next);
      setOptionsError("");
      try { localStorage.setItem(preferencesKey, JSON.stringify(next)); } catch {}
    } catch (reason) { setOptionsError(reason instanceof Error ? reason.message : "语音选项无效。"); }
  }

  return { phase, model, models, disabled, seconds, error, canvas, start, stop, cancel, selectModel,
    local, supportsHotwords, preferences, hotwordText, optionsError, updatePreferences };
}

type VoiceState = ReturnType<typeof useVoiceInput>;

export function VoicePreferences({ voice }: { voice: VoiceState }) {
  if (!voice.local) return null;
  return <fieldset className="voice-preferences" disabled={voice.disabled || voice.phase !== "idle"}>
    <legend>本地识别选项</legend>
    <label>断句方式<select aria-label="语音断句方式" value={voice.preferences.punctuation} onChange={(event) => voice.updatePreferences(voice.hotwordText, event.target.value as VoiceOptions["punctuation"])}>
      <option value="smart">上下文标点（不润色原话）</option><option value="original">保留模型原标点</option>
    </select></label>
    <label>常用术语<textarea aria-label="语音常用术语" rows={2} maxLength={500} value={voice.hotwordText} placeholder="例如 Codex, TypeScript, FastAPI" disabled={!voice.supportsHotwords} onChange={(event) => voice.updatePreferences(event.target.value, voice.preferences.punctuation)} /></label>
    <small>{voice.supportsHotwords ? "逗号或换行分隔；最多20项、总长160字。仅辅助拼写，不保证正确。" : "当前模型不支持术语提示；可改用Qwen或Fun-ASR。"}</small>
    {voice.supportsHotwords && voice.optionsError && <p role="alert">{voice.optionsError}</p>}
  </fieldset>;
}

export function VoiceControls({ voice }: { voice: VoiceState }) {
  if (!voice.models.length) return null;
  return <>
    {voice.phase === "recording"
      ? <button type="button" className="mic-button recording" onClick={() => voice.stop()} title="结束录音并转写到草稿" aria-label="停止录音并转写"><Square size={16} fill="currentColor" /></button>
      : <button type="button" className="mic-button" onClick={() => void voice.start()} disabled={voice.disabled || voice.phase !== "idle"} title="录音输入" aria-label="录音输入">{voice.phase === "idle" ? <Mic size={17} /> : <LoaderCircle className="spin" size={17} />}</button>}
  </>;
}

export function VoiceStatus({ voice }: { voice: VoiceState }) {
  return <>
    {voice.phase !== "idle" && <div className="voice-status" role="status">{voice.phase === "recording"
      ? <><canvas ref={voice.canvas} width={160} height={24} aria-label="录音音量" /><time>{Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, "0")}</time><span>结束录音回填草稿，或点击发送以转写并发送</span></>
      : <span>{voice.phase === "requesting" ? "等待麦克风权限…" : "正在识别语音…"}</span>}<button type="button" className="voice-cancel" onClick={voice.cancel} title="取消语音输入" aria-label="取消语音输入"><X size={16} /></button></div>}
    {voice.error && <p className="voice-error" role="alert">{voice.error}</p>}
  </>;
}
