import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const LOCAL_VOICE_MODELS = [
  { id: "sensevoice-small-int8", label: "SenseVoiceSmall INT8", local: true },
  { id: "qwen3-asr-0.6b", label: "Qwen3-ASR-0.6B", local: true },
] as const;

export class LocalTranscriptionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function transcribeLocally(socketPath: string, filePath: string, model: string, timeoutMs: number): Promise<string> {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 107 || socketPath.includes("\0")) {
    return Promise.reject(new LocalTranscriptionError("本地语音服务的 socket 路径无效或过长，请联系管理员。", 503));
  }
  if (!LOCAL_VOICE_MODELS.some((candidate) => candidate.id === model)) {
    return Promise.reject(new LocalTranscriptionError("请选择有效的本地语音模型。", 400));
  }
  const audio = fs.readFileSync(filePath);
  if (audio.length > 15 * 1024 * 1024) return Promise.reject(new LocalTranscriptionError("录音文件过大。", 413));
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, agent: false, path: `/transcribe/${model}`, method: "POST", headers: {
      "Content-Type": "application/octet-stream", "Content-Length": audio.length,
      "X-Audio-Extension": filePath.split(".").pop() ?? "",
    } });
    const deadline = setTimeout(() => request.destroy(new LocalTranscriptionError("本地语音识别超时，请缩短录音后重试。", 504)), timeoutMs);
    deadline.unref();
    const fail = (error: Error) => {
      clearTimeout(deadline);
      reject(error instanceof LocalTranscriptionError ? error : new LocalTranscriptionError("本地语音服务不可用，请联系管理员检查服务状态。", 503));
    };
    request.on("error", fail);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", fail);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) request.destroy(new LocalTranscriptionError("本地语音服务返回的数据过大。", 502));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(deadline);
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200) {
            const status = [400, 413, 422, 429, 503, 504].includes(response.statusCode ?? 0) ? response.statusCode! : 502;
            const message = typeof body === "object" && body && "error" in body && typeof body.error === "string" ? body.error.slice(0, 300) : "本地语音识别失败。";
            reject(new LocalTranscriptionError(message, status));
          } else if (typeof body === "object" && body && "text" in body && typeof body.text === "string") {
            if (!body.text.trim()) reject(new LocalTranscriptionError("未检测到有效人声，请靠近麦克风重试。", 422));
            else resolve(body.text.trim());
          } else reject(new LocalTranscriptionError("本地语音服务返回了无效结果。", 502));
        } catch { reject(new LocalTranscriptionError("本地语音服务返回了无效结果。", 502)); }
      });
    });
    request.end(audio);
  });
}
