import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { api, type VoiceModelOption } from "./api";
import { validVoiceModel } from "./voice-input-state";

type Phase = "idle" | "requesting" | "recording" | "transcribing";

export function VoiceInput({ models, preferenceKey, conversationId, disabled, draftText = "", attachmentNames = [], onTranscript, onBusyChange }: {
  models: VoiceModelOption[];
  preferenceKey: string;
  conversationId?: string;
  disabled: boolean;
  draftText?: string;
  attachmentNames?: string[];
  onTranscript: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const storageKey = `codex-web:voice-model:${preferenceKey}`;
  const [selected, setSelected] = useState(() => {
    try { return validVoiceModel(localStorage.getItem(storageKey), models); }
    catch { return validVoiceModel(null, models); }
  });
  const model = validVoiceModel(selected, models);
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
  const callbacks = useRef({ onTranscript, onBusyChange });
  callbacks.current = { onTranscript, onBusyChange };

  function transition(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
    callbacks.current.onBusyChange(next !== "idle");
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
    controller.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
    release();
    transition("idle");
  }

  useEffect(() => () => {
    generation.current += 1;
    controller.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    callbacks.current.onBusyChange(false);
  }, []);

  function stop() {
    if (phaseRef.current !== "recording" || recorder.current?.state !== "recording") return;
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
    if (!window.isSecureContext) { setError("麦克风需要 HTTPS 或 localhost 安全环境。"); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("当前浏览器不支持录音，请使用 Chrome、Edge 或 Safari。"); return; }
    const current = ++generation.current;
    const chunks: Blob[] = [];
    const context = { conversationId, model, draftText, attachmentNames };
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
          callbacks.current.onTranscript(result.text);
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
      limit.current = window.setTimeout(stop, 300_000);
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

  if (!models.length) return null;
  return <div className="voice-input">
    <div className="voice-input-controls">
      <label>语音模型<select aria-label="语音识别模型" value={model} disabled={phase !== "idle" || disabled} onChange={(event) => {
        setSelected(event.target.value);
        try { localStorage.setItem(storageKey, event.target.value); } catch {}
      }}>{models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      {phase === "idle" ? <button type="button" className="mic-button" onClick={() => void start()} disabled={disabled} title="录音输入，停止后回填草稿" aria-label="录音输入"><Mic size={17} /></button>
        : <><button type="button" className="voice-cancel" onClick={cancel} aria-label="取消语音输入"><X size={16} /></button>{phase === "recording" ? <><canvas ref={canvas} width={160} height={24} aria-label="录音音量" /><time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</time><button type="button" className="voice-stop" onClick={stop} aria-label="停止录音并转写"><Square size={14} /></button></> : <><LoaderCircle className="spin" size={16} /><span role="status">{phase === "requesting" ? "等待麦克风权限…" : "正在识别语音…"}</span></>}</>}
    </div>
    {error && <p className="voice-error" role="alert">{error}</p>}
  </div>;
}
