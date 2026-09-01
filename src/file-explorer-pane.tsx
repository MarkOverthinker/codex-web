import { Fragment, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import {
  ChevronDown, ChevronRight, Download, File as FileIcon, FileImage, FileText, Folder, FolderOpen, FolderTree,
  LoaderCircle, RefreshCw, TriangleAlert, X,
} from "lucide-react";
import { api, type FileTreeEntry, type FileTreeListing, type FileTreePreview, type FileTreeRoot } from "./api";
import { CopyPathButton } from "./copy-path";
import { normalizeMathDelimiters } from "./markdown-math";
import { isTextPreviewMime } from "./text-preview";

const FILE_TREE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

type FileSelection = { rootId: FileTreeRoot["id"]; entry: FileTreeEntry };
type PreviewKind = "image" | "pdf" | "markdown" | "text" | null;

function directoryKey(rootId: FileTreeRoot["id"], directoryPath: string): string {
  return `${rootId}:${directoryPath}`;
}

function formatSize(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function previewKind(entry: FileTreeEntry): PreviewKind {
  const mime = entry.mime_type.toLowerCase().split(";", 1)[0].trim();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (/\.(?:md|markdown)$/i.test(entry.name)) return "markdown";
  if (isTextPreviewMime(mime) && (entry.size ?? 0) <= FILE_TREE_PREVIEW_MAX_BYTES) return "text";
  return null;
}

function entryIcon(entry: FileTreeEntry) {
  if (entry.type === "dir") return <Folder size={15} />;
  if (entry.mime_type.toLowerCase().startsWith("image/")) return <FileImage size={15} />;
  if (isTextPreviewMime(entry.mime_type)) return <FileText size={15} />;
  return <FileIcon size={15} />;
}

export function FileExplorerPane({ conversationId, width, onResizeStart, onResizeKeyDown, onClose }: {
  conversationId: string;
  width: number;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent) => void;
  onClose: () => void;
}) {
  const [roots, setRoots] = useState<FileTreeRoot[]>([]);
  const [listings, setListings] = useState<Record<string, FileTreeListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileSelection | null>(null);
  const [preview, setPreview] = useState<FileTreePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setRoots([]);
    setListings({});
    setExpanded(new Set());
    setSelectedFile(null);
    setPreview(null);
    setPreviewError("");
    void api.fileTree(conversationId)
      .then(async ({ roots: nextRoots }) => {
        if (cancelled) return;
        setRoots(nextRoots);
        const availableRoots = nextRoots.filter((root) => root.available);
        const loaded = await Promise.all(availableRoots.map(async (root) => {
          try {
            const result = await api.fileTree(conversationId, root.id, "");
            return result.listing ? [directoryKey(root.id, ""), result.listing] as const : null;
          } catch {
            return null;
          }
        }));
        if (cancelled) return;
        setListings(Object.fromEntries(loaded.filter((item): item is readonly [string, FileTreeListing] => item !== null)));
        setExpanded(new Set(availableRoots.map((root) => directoryKey(root.id, ""))));
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "文件目录加载失败。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [conversationId, reloadVersion]);

  useEffect(() => {
    const selected = selectedFile;
    if (!selected || !selected.entry.previewable || !previewKind(selected.entry) || ["image", "pdf"].includes(previewKind(selected.entry)!)) {
      setPreview(null);
      setPreviewError("");
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    setPreviewError("");
    void api.fileTreePreview(conversationId, selected.rootId, selected.entry.path, controller.signal)
      .then((result) => setPreview(result))
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setPreviewError(reason instanceof Error ? reason.message : "文件预览加载失败。");
      });
    return () => controller.abort();
  }, [conversationId, selectedFile?.entry.path, selectedFile?.entry.previewable, selectedFile?.rootId]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function loadDirectory(rootId: FileTreeRoot["id"], path: string): Promise<void> {
    const key = directoryKey(rootId, path);
    setLoadingDirectories((current) => new Set(current).add(key));
    setError("");
    try {
      const result = await api.fileTree(conversationId, rootId, path);
      if (result.listing) setListings((current) => ({ ...current, [key]: result.listing! }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "目录加载失败。");
    } finally {
      setLoadingDirectories((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function toggleDirectory(rootId: FileTreeRoot["id"], path: string): void {
    const key = directoryKey(rootId, path);
    if (expanded.has(key)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(key));
    if (!listings[key]) void loadDirectory(rootId, path);
  }

  function selectEntry(rootId: FileTreeRoot["id"], entry: FileTreeEntry): void {
    if (entry.type === "dir") {
      toggleDirectory(rootId, entry.path);
      return;
    }
    if (entry.type === "file") setSelectedFile({ rootId, entry });
  }

  function renderDirectory(rootId: FileTreeRoot["id"], path: string, level: number) {
    const key = directoryKey(rootId, path);
    const listing = listings[key];
    if (!listing) {
      return loadingDirectories.has(key) ? <div className="file-tree-loading-row" style={{ "--tree-level": level } as CSSProperties}><LoaderCircle className="spin" size={14} />读取中…</div> : null;
    }
    if (listing.entries.length === 0) return <div className="file-tree-empty-row" style={{ "--tree-level": level } as CSSProperties}>空目录</div>;
    return listing.entries.map((entry) => {
      const entryKey = directoryKey(rootId, entry.path);
      const isExpanded = entry.type === "dir" && expanded.has(entryKey);
      const selected = selectedFile?.rootId === rootId && selectedFile.entry.path === entry.path;
      return <Fragment key={entryKey}>
        <button
          type="button"
          className={`file-tree-row ${entry.type === "dir" ? "directory" : "file"} ${isExpanded ? "expanded" : ""} ${selected ? "selected" : ""}`}
          style={{ "--tree-level": level } as CSSProperties}
          title={entry.display_path}
          aria-expanded={entry.type === "dir" ? isExpanded : undefined}
          onClick={() => selectEntry(rootId, entry)}
        >
          <span className="file-tree-chevron">{entry.type === "dir" ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
          <span className="file-tree-entry-icon">{entry.type === "dir" ? (isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />) : entryIcon(entry)}</span>
          <span className="file-tree-entry-name">{entry.name}</span>
          <span className="file-tree-entry-meta">{entry.type === "file" ? formatSize(entry.size) : ""}</span>
        </button>
        {entry.type === "dir" && isExpanded && renderDirectory(rootId, entry.path, level + 1)}
      </Fragment>;
    });
  }

  const selectedKind = useMemo(() => selectedFile ? previewKind(selectedFile.entry) : null, [selectedFile]);
  const selectedSource = selectedFile ? api.fileTreeFileUrl(conversationId, selectedFile.rootId, selectedFile.entry.path) : "";
  const selectedDownload = selectedFile ? api.fileTreeFileUrl(conversationId, selectedFile.rootId, selectedFile.entry.path, true) : "";

  return <aside className="file-explorer-pane" style={{ width }} aria-label="文件浏览器">
    <div
      className="file-explorer-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整文件栏宽度"
      aria-valuemin={340}
      aria-valuemax={760}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={onResizeStart}
      onKeyDown={onResizeKeyDown}
    />
    <header className="file-explorer-header">
      <div><FolderTree size={18} /><span><strong>文件</strong><small>当前会话可访问的目录</small></span></div>
      <span className="file-explorer-actions">
        <button type="button" className="icon-button" aria-label="刷新文件树" title="刷新" onClick={() => setReloadVersion((value) => value + 1)} disabled={loading}><RefreshCw size={16} /></button>
        <button type="button" className="icon-button" aria-label="关闭文件浏览器" title="关闭" onClick={onClose}><X size={18} /></button>
      </span>
    </header>
    {error && <div className="file-explorer-error" role="alert"><TriangleAlert size={15} />{error}</div>}
    <div className="file-explorer-body">
      <div className="file-explorer-tree" aria-label="文件树">
        {loading && <div className="file-explorer-status"><LoaderCircle className="spin" size={18} />正在读取文件目录…</div>}
        {!loading && roots.length === 0 && <div className="file-explorer-status">当前会话没有可浏览的目录。</div>}
        {!loading && roots.map((root) => {
          const key = directoryKey(root.id, "");
          const isExpanded = expanded.has(key);
          return <Fragment key={root.id}>
            <button type="button" className={`file-tree-root ${root.available ? "" : "unavailable"} ${isExpanded ? "expanded" : ""}`} title={root.path} aria-expanded={root.available ? isExpanded : undefined} disabled={!root.available} onClick={() => root.available && toggleDirectory(root.id, "")}>
              <span className="file-tree-chevron">{root.available ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
              <span className="file-tree-entry-icon"><FolderOpen size={16} /></span>
              <span className="file-tree-entry-name"><strong>{root.label}</strong><small>{root.available ? root.path : "目录不可用"}</small></span>
            </button>
            {root.available && isExpanded && renderDirectory(root.id, "", 1)}
          </Fragment>;
        })}
      </div>
      <div className="file-explorer-preview">
        {!selectedFile && <div className="file-explorer-preview-empty"><FileText size={24} /><strong>选择文件预览</strong><span>支持文本、Markdown、图片和 PDF 文件。</span></div>}
        {selectedFile && <>
          <header className="file-explorer-preview-header">
            {selectedKind === "image" ? <FileImage size={17} /> : <FileText size={17} />}
            <span><strong>{selectedFile.entry.name}</strong><small title={selectedFile.entry.display_path}>{selectedFile.entry.display_path} · {formatSize(selectedFile.entry.size)}</small></span>
            <CopyPathButton value={selectedFile.entry.display_path} className="file-explorer-copy" />
            <a className="icon-button" href={selectedDownload} download={selectedFile.entry.name} title="下载" aria-label="下载文件"><Download size={16} /></a>
          </header>
          <div className={`file-explorer-preview-body ${selectedKind === "image" || selectedKind === "pdf" ? "fit" : ""}`}>
            {selectedKind === "image" && <img className="file-explorer-preview-image" src={selectedSource} alt={selectedFile.entry.name} />}
            {selectedKind === "pdf" && <iframe className="file-explorer-preview-frame" src={selectedSource} title={selectedFile.entry.name} />}
            {selectedKind === "markdown" && (previewError ? <FileExplorerPreviewError error={previewError} /> : preview === null ? <FileExplorerPreviewLoading /> : <div className="markdown file-explorer-preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}>{normalizeMathDelimiters(preview.content)}</ReactMarkdown></div>)}
            {selectedKind === "text" && (previewError ? <FileExplorerPreviewError error={previewError} /> : preview === null ? <FileExplorerPreviewLoading /> : <pre className="file-explorer-preview-plain">{preview.content}</pre>)}
            {!selectedKind && <FileExplorerPreviewError error={selectedFile.entry.previewable ? "该文件格式暂不支持页内预览。" : "文件过大或格式不支持页内预览，请下载后查看。"} />}
          </div>
        </>}
      </div>
    </div>
  </aside>;
}

function FileExplorerPreviewLoading() {
  return <div className="file-explorer-preview-status"><LoaderCircle className="spin" size={20} />正在加载预览…</div>;
}

function FileExplorerPreviewError({ error }: { error: string }) {
  return <div className="file-explorer-preview-status error"><TriangleAlert size={20} />{error}</div>;
}
