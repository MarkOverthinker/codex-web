import { z } from "zod";

export const voiceOptionsSchema = z.object({
  hotwords: z.array(z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f,，<>]+$/u)).max(20).default([]),
  punctuation: z.enum(["smart", "original"]).default("smart"),
}).strict().refine((value) => value.hotwords.reduce((total, word) => total + word.length, 0) <= 160);

export type VoiceOptions = z.infer<typeof voiceOptionsSchema>;

export function parseVoiceOptions(value: unknown): VoiceOptions {
  const parsed = voiceOptionsSchema.safeParse(value);
  if (!parsed.success) throw new Error("语音选项无效：最多20个术语，每个1–40字，总长不超过160字；不能含控制字符或尖括号。");
  return { ...parsed.data, hotwords: [...new Set(parsed.data.hotwords)] };
}

export function hotwordsFromText(text: string): string[] {
  return text.split(/[,，\n]/u).map((word) => word.trim()).filter(Boolean);
}
