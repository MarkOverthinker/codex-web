import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* Fall through to the legacy selection copy below. */ }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch { return false; }
}

export function CopyPathButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const timer = window.setTimeout(() => { setCopied(false); setFailed(false); }, 1600);
    return () => window.clearTimeout(timer);
  }, [copied, failed]);
  async function handleCopy() {
    const ok = await copyText(value);
    setCopied(ok);
    setFailed(!ok);
  }
  const label = failed ? "复制失败" : copied ? "已复制" : "复制路径";
  return <button type="button" className={`copy-path-button ${copied ? "copied" : ""} ${failed ? "failed" : ""} ${className ?? ""}`} title={label} aria-label={label} onClick={() => void handleCopy()}>
    {copied ? <Check size={14} /> : <Copy size={14} />}
  </button>;
}
