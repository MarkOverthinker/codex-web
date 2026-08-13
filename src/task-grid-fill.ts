export const TASK_GRID_GAP = 8;
export const TASK_GRID_MIN_COLUMN_WIDTH = 160;

export type TaskGridCardPlacement = {
  left: number;
  top: number;
  width: number;
};

export type TaskGridPack = {
  columns: number;
  height: number;
  cards: readonly TaskGridCardPlacement[];
};

/**
 * Pack category cards in priority order (top-left to bottom-right) with a
 * shortest-column greedy fill: the first `columns` cards run left to right
 * across the first row, then every following card joins the column with the
 * smallest current height (ties resolve to the leftmost column). Cards keep
 * their natural height instead of being forced onto uniform rows.
 *
 * The grid starts with one column and widens until the packed height fits the
 * available height, or until the minimum column width limit is reached; beyond
 * that it falls back to vertical scrolling instead of overflowing
 * horizontally.
 */
export function packTaskGrid(
  cardHeights: readonly number[],
  availableHeight: number,
  availableWidth: number,
  minColumnWidth = TASK_GRID_MIN_COLUMN_WIDTH,
  gap = TASK_GRID_GAP,
): TaskGridPack {
  const heights = cardHeights.map((rawHeight) => Math.max(0, Number.isFinite(rawHeight) ? rawHeight : 0));
  if (heights.length === 0) return { columns: 1, height: 0, cards: [] };
  const safeMinWidth = Math.max(1, minColumnWidth);
  const safeGap = Math.max(0, gap);
  const safeWidth = Math.max(0, availableWidth);
  const maxColumns = Math.max(1, Math.floor((safeWidth + safeGap) / (safeMinWidth + safeGap)));
  if (availableHeight <= 0 || maxColumns <= 1) {
    return packIntoColumns(heights, 1, safeWidth, safeGap);
  }
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const pack = packIntoColumns(heights, columns, safeWidth, safeGap);
    if (pack.height <= availableHeight) {
      return pack;
    }
  }
  return packIntoColumns(heights, maxColumns, safeWidth, safeGap);
}

function packIntoColumns(heights: readonly number[], columns: number, availableWidth: number, gap: number): TaskGridPack {
  const columnWidth = Math.max(0, (availableWidth - (columns - 1) * gap) / columns);
  const columnBottoms = new Array<number>(columns).fill(0);
  const cards = heights.map((height) => {
    let column = 0;
    for (let candidate = 1; candidate < columns; candidate += 1) {
      if (columnBottoms[candidate] < columnBottoms[column]) column = candidate;
    }
    const top = columnBottoms[column];
    columnBottoms[column] += height + gap;
    return { left: column * (columnWidth + gap), top, width: columnWidth };
  });
  const height = Math.max(0, Math.max(...columnBottoms) - gap);
  return { columns, height, cards };
}
