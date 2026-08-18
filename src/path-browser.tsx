import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Check, FileText, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import { api, type HostPathEntry } from "./api";

export type PathBrowserMode = "dir" | "files";
export type PathBrowserRequest = {
  mode: PathBrowserMode;
  title: string;
  initialPath?: string;
  confirmLabel?: string;
  maxFiles?: number;
  onSelect: (paths: string[]) => void;
};

const MAX_HOST_ATTACHMENTS = 12;

function formatEntrySize(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function PathBrowserDialog({ request, onClose }: { request: PathBrowserRequest | null; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<HostPathEntry[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setPath(""); setParent(null); setEntries([]); setPathInput(request.initialPath ?? ""); setError(""); setSelectedDir(null); setSelectedFiles([]); setLoading(true);
    void api.browsePath(request.initialPath).then(({ listing }) => {
      if (cancelled) return;
      setPath(listing.path);
      setParent(listing.parent);
      setEntries(listing.entries);
      setPathInput(listing.path);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法浏览该目录。");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    const frame = window.requestAnimationFrame(() => inputRef.current?.select());
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [request]);

  if (!request) return null;
  const activeRequest = request;

  async function navigate(target?: string) {
    if (loading) return;
    const requested = target ?? pathInput.trim();
    if (!requested) return;
    setLoading(true); setError(""); setSelectedDir(null); setSelectedFiles([]);
    try {
      const { listing } = await api.browsePath(requested);
      setPath(listing.path); setParent(listing.parent); setEntries(listing.entries); setPathInput(listing.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法浏览该目录。");
    } finally {
      setLoading(false);
    }
  }

  function rowClick(entry: HostPathEntry) {
    if (entry.type === "dir") {
      if (activeRequest.mode === "dir") {
        setSelectedDir(selectedDir === entry.path ? null : entry.path);
      } else {
        void navigate(entry.path);
      }
      return;
    }
    if (activeRequest.mode !== "files") return;
    const limit = activeRequest.maxFiles ?? MAX_HOST_ATTACHMENTS;
    setSelectedFiles((current) => {
      if (current.includes(entry.path)) return current.filter((item) => item !== entry.path);
      if (current.length >= limit) {
        setError(`最多选择 ${limit} 个文件。`);
        return current;
      }
      setError("");
      return [...current, entry.path];
    });
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") { event.preventDefault(); void navigate(); }
    if (event.key === "Escape") onClose();
  }

  function confirm() {
    if (activeRequest.mode === "dir") {
      if (!selectedDir) return;
      activeRequest.onSelect([selectedDir]);
    } else {
      if (selectedFiles.length === 0) return;
      activeRequest.onSelect(selectedFiles);
    }
    onClose();
  }

  return createPortal(<div className="path-browser-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="path-browser" role="dialog" aria-modal="true" aria-label={activeRequest.title}>
      <header>
        <div><FolderOpen size={18} /><strong>{activeRequest.title}</strong></div>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="path-browser-location">
        <div className="path-browser-current" title={path}>{path || "加载中…"}</div>
        <div className="path-browser-controls">
          <button type="button" className="path-browser-up" title="上级目录" aria-label="上级目录" disabled={loading || !parent} onClick={() => void navigate(parent ?? undefined)}><ArrowUp size={15} /></button>
          <input ref={inputRef} value={pathInput} onChange={(event) => setPathInput(event.target.value)} onKeyDown={keyDown} placeholder="绝对路径" spellCheck={false} />
          <button type="button" className="primary-button" disabled={loading || !pathInput.trim()} onClick={() => void navigate()}>前往</button>
        </div>
      </div>
      {error && <div className="path-browser-error" role="alert">{error}</div>}
      <div className="path-browser-list" aria-busy={loading}>
        {loading
          ? <div className="path-browser-loading"><LoaderCircle className="spin" size={20} />正在读取目录…</div>
          : entries.length === 0
            ? <div className="path-browser-empty">空目录</div>
            : entries.map((entry) => {
              const isDir = entry.type === "dir";
              const selected = activeRequest.mode === "dir" ? selectedDir === entry.path : selectedFiles.includes(entry.path);
              return <button key={entry.path} type="button" className={`path-browser-row ${selected ? "selected" : ""}`} onClick={() => rowClick(entry)} onDoubleClick={() => { if (isDir) void navigate(entry.path); }}>
                <span className="path-browser-row-icon">{isDir ? <Folder size={16} /> : <FileText size={15} />}</span>
                <span className="path-browser-row-name" title={entry.name}>{entry.name}</span>
                <span className="path-browser-row-meta">{isDir ? "目录" : formatEntrySize(entry.size)}</span>
                {selected && <Check size={14} className="path-browser-row-check" />}
              </button>;
            })}
      </div>
      {activeRequest.mode === "files" && selectedFiles.length > 0 && <div className="path-browser-selection">已选择 {selectedFiles.length} 个文件</div>}
      <footer>
        <button type="button" className="path-browser-cancel" onClick={onClose}>取消</button>
        <button type="button" className="primary-button" disabled={activeRequest.mode === "dir" ? !selectedDir : selectedFiles.length === 0} onClick={confirm}>
          {activeRequest.confirmLabel ?? (activeRequest.mode === "dir" ? "选择目录" : "添加文件")}
        </button>
      </footer>
    </section>
  </div>, document.body);
}
