import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import { MOBILE_MEDIA_QUERY } from "./mobile-input";

function subscribe(listener: () => void) {
  const media = window.matchMedia(MOBILE_MEDIA_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(MOBILE_MEDIA_QUERY).matches, () => false);
}

export function MobileTools({ label, summary, targetId, children }: { label: string; summary?: string; targetId?: string; children: ReactNode }) {
  const mobile = useMobileLayout();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();

  useEffect(() => { setTarget(targetId ? document.getElementById(targetId) : null); }, [targetId, mobile]);
  useEffect(() => {
    if (!mobile || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    const shell = document.querySelector<HTMLElement>(".shell");
    const wasInert = shell?.inert ?? false;
    if (shell) shell.inert = true;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (shell) shell.inert = wasInert;
      const active = document.activeElement;
      if (previous?.isConnected && (active === document.body || panel.current?.contains(active))) previous.focus();
    };
  }, [mobile, open]);

  if (!mobile) return <>{children}</>;
  const trigger = <button type="button" className="mobile-tools-trigger" aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}><SlidersHorizontal size={19} />{summary && <span>{summary}</span>}</button>;
  return <>
    {target ? createPortal(trigger, target) : trigger}
    {createPortal(<div className="mobile-sheet-backdrop" hidden={!open} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section ref={panel} className="mobile-sheet" role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
        if (event.key !== "Tab") return;
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <header><div><strong id={headingId}>{label}</strong><small>按需选择，主界面保持简洁</small></div><button type="button" className="icon-button" aria-label={`关闭${label}`} onClick={() => setOpen(false)}><X size={21} /></button></header>
        <div className="mobile-sheet-content" onClick={(event) => {
          const button = (event.target as HTMLElement).closest("button, a");
          if (button?.matches(".chat-tool-trigger, .side-chat-toggle, .host-attach, .preset-menu-manage")) setOpen(false);
        }}>{children}</div>
      </section>
    </div>, document.body)}
  </>;
}

export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      if (viewport.scale !== 1) return;
      document.documentElement.style.setProperty("--mobile-height", `${Math.round(viewport.height)}px`);
      document.documentElement.style.setProperty("--mobile-top", `${Math.round(viewport.offsetTop)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--mobile-height");
      document.documentElement.style.removeProperty("--mobile-top");
    };
  }, []);
}

export function useMobileDrawer(open: boolean, close: () => void) {
  const mobile = useMobileLayout();
  useEffect(() => {
    if (!mobile || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    const workspace = document.querySelector<HTMLElement>(".workspace");
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    if (workspace) workspace.inert = true;
    sidebar?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus();
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !sidebar?.contains(document.activeElement)) return;
      const controls = [...sidebar.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      if (workspace) workspace.inert = false;
      document.removeEventListener("keydown", handleKey);
      if (previous?.isConnected && sidebar?.contains(document.activeElement)) previous.focus();
    };
  }, [mobile, open, close]);
}

export function installMobileBack() {
  const visible = (element: HTMLElement) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const layer = (element: HTMLElement) => {
    let result = 0;
    for (let current: HTMLElement | null = element; current; current = current.parentElement) result = Math.max(result, Number.parseInt(getComputedStyle(current).zIndex) || 0);
    return result;
  };
  const back = () => {
    const overlays = [...document.querySelectorAll<HTMLElement>('[role="dialog"], .file-preview-pane, .side-chat-pane, .file-explorer-pane:not(.embedded), .repository-pane, .code-snippet-pane')].filter(visible).reverse().sort((left, right) => layer(right) - layer(left));
    for (const overlay of overlays) {
      const expanded = overlay.matches(".repository-pane") ? undefined : [...overlay.querySelectorAll<HTMLButtonElement>('button[aria-expanded="true"]')].filter(visible).at(-1);
      if (expanded) { expanded.click(); return true; }
      const close = [...overlay.querySelectorAll<HTMLButtonElement>("button")].find((button) => visible(button) && /^(关闭|返回)/.test(button.getAttribute("aria-label") ?? button.title));
      if (close) { close.click(); return true; }
    }
    const sidebar = document.querySelector<HTMLElement>(".sidebar.open");
    if (sidebar) {
      const settings = sidebar.querySelector<HTMLButtonElement>('.account-profile[aria-expanded="true"]');
      (settings ?? sidebar.querySelector<HTMLButtonElement>('[aria-label="关闭"]'))?.click();
      return true;
    }
    const terminalClose = document.querySelector<HTMLButtonElement>('.terminal-sidebar [aria-label="关闭终端栏"]');
    if (terminalClose && visible(terminalClose)) { terminalClose.click(); return true; }
    return false;
  };
  Object.assign(window, { codexMobileBack: back });
}
