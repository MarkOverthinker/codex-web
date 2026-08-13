import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { packTaskGrid } from "./task-grid-fill";

export type TaskCategoryGridLayout = {
  containerRef: RefObject<HTMLDivElement | null>;
  gridStyle: CSSProperties | undefined;
};

/**
 * Measure the category cards and the scroll container, then lay the cards out
 * in column-major order so a column that cannot hold every card automatically
 * wraps into additional columns. Re-measures whenever cards resize, the
 * container resizes, or new cards appear.
 */
export function useTaskCategoryGridLayout(active: boolean, layoutKey: number): TaskCategoryGridLayout {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [gridStyle, setGridStyle] = useState<CSSProperties | undefined>(undefined);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!active || !container) {
      setGridStyle(undefined);
      return;
    }

    let frame = 0;
    let appliedColumns = 0;
    let appliedRows = 0;
    let disposed = false;

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const grid = container.querySelector<HTMLElement>(".task-category-grid");
        if (!grid) {
          setGridStyle(undefined);
          return;
        }
        const cards = Array.from(grid.children).filter((child): child is HTMLElement =>
          child instanceof HTMLElement && child.classList.contains("task-category-card"));
        if (cards.length === 0) {
          setGridStyle(undefined);
          return;
        }
        const heights = cards.map((card) => card.getBoundingClientRect().height);
        const pack = packTaskGrid(heights, container.clientHeight, container.clientWidth);
        if (pack.columns === appliedColumns && pack.rows === appliedRows) return;
        appliedColumns = pack.columns;
        appliedRows = pack.rows;
        setGridStyle({
          display: "grid",
          gridTemplateColumns: `repeat(${pack.columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.max(1, pack.rows)}, max-content)`,
          gridAutoFlow: "column",
          alignItems: "start",
        });
      });
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    const attachGridObservers = () => {
      const grid = container.querySelector<HTMLElement>(".task-category-grid");
      if (!grid) return;
      observer.observe(grid);
      for (const child of grid.children) {
        if (child instanceof Element) observer.observe(child);
      }
      schedule();
    };
    const mutationObserver = new MutationObserver(attachGridObservers);
    mutationObserver.observe(container, { childList: true, subtree: true });
    attachGridObservers();
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      observer.disconnect();
    };
  }, [active, layoutKey]);

  return { containerRef, gridStyle };
}
