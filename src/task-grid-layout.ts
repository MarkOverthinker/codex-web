import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { packTaskGrid } from "./task-grid-fill";

export type TaskCategoryGridLayout = {
  containerRef: RefObject<HTMLDivElement | null>;
  gridStyle: CSSProperties | undefined;
  cardStyles: readonly CSSProperties[];
};

/**
 * Measure the category cards and the scroll container, then lay the cards out
 * in priority order (top-left to bottom-right) with a shortest-column fill:
 * the first row runs left to right, then each following card joins the column
 * with the smallest current height (ties go to the leftmost column). Cards are
 * absolutely positioned inside a measured container so different heights no
 * longer force uniform row gaps. Re-measures whenever cards resize, the
 * container resizes, or cards are added/removed.
 */
export function useTaskCategoryGridLayout(active: boolean, layoutKey: number): TaskCategoryGridLayout {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [gridStyle, setGridStyle] = useState<CSSProperties | undefined>(undefined);
  const [cardStyles, setCardStyles] = useState<readonly CSSProperties[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!active || !container) {
      setGridStyle(undefined);
      setCardStyles([]);
      return;
    }

    let frame = 0;
    let appliedSignature = "";
    let disposed = false;

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const grid = container.querySelector<HTMLElement>(".task-category-grid");
        if (!grid) {
          setGridStyle(undefined);
          setCardStyles([]);
          return;
        }
        const cards = Array.from(grid.children).filter((child): child is HTMLElement =>
          child instanceof HTMLElement && child.classList.contains("task-category-card"));
        if (cards.length === 0) {
          setGridStyle(undefined);
          setCardStyles([]);
          return;
        }
        const heights = cards.map((card) => card.getBoundingClientRect().height);
        const pack = packTaskGrid(heights, container.clientHeight, container.clientWidth);
        const signature = `${pack.height}|${JSON.stringify(pack.cards)}`;
        if (signature === appliedSignature) return;
        appliedSignature = signature;
        setGridStyle({
          position: "relative",
          display: "block",
          height: `${pack.height}px`,
        });
        setCardStyles(pack.cards.map((card) => ({
          position: "absolute",
          left: `${card.left}px`,
          top: `${card.top}px`,
          width: `${card.width}px`,
        })));
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

  return { containerRef, gridStyle, cardStyles };
}
