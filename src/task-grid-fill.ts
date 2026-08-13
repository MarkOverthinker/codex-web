export const TASK_GRID_GAP = 8;
export const TASK_GRID_MIN_COLUMN_WIDTH = 160;

export type TaskGridPack = {
  columns: number;
  rows: number;
};

/**
 * Pack category cards in row-major (priority) order: the first card sits in
 * the top-left cell, the next one moves right, and a full row wraps to the
 * next row below. The grid starts with one column and widens until the total
 * row height fits the available height, or until the width limit is reached;
 * beyond that it falls back to vertical scrolling instead of overflowing
 * horizontally.
 */
export function packTaskGrid(
  cardHeights: readonly number[],
  availableHeight: number,
  availableWidth: number,
  minColumnWidth = TASK_GRID_MIN_COLUMN_WIDTH,
  gap = TASK_GRID_GAP,
): TaskGridPack {
  if (cardHeights.length === 0) return { columns: 1, rows: 0 };
  const safeMinWidth = Math.max(1, minColumnWidth);
  const maxColumns = Math.max(1, Math.floor((Math.max(0, availableWidth) + gap) / (safeMinWidth + gap)));
  if (availableHeight <= 0 || maxColumns <= 1) {
    return { columns: 1, rows: cardHeights.length };
  }
  const heights = cardHeights.map((rawHeight) => Math.max(0, Number.isFinite(rawHeight) ? rawHeight : 0));
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(heights.length / columns);
    if (rowMajorTotalHeight(heights, columns, gap) <= availableHeight) {
      return { columns, rows };
    }
  }
  return { columns: maxColumns, rows: Math.ceil(heights.length / maxColumns) };
}

function rowMajorTotalHeight(heights: readonly number[], columns: number, gap: number): number {
  let total = 0;
  for (let start = 0; start < heights.length; start += columns) {
    let rowHeight = 0;
    for (let index = start; index < Math.min(start + columns, heights.length); index += 1) {
      rowHeight = Math.max(rowHeight, heights[index]);
    }
    total += rowHeight;
  }
  return total + Math.max(0, Math.ceil(heights.length / columns) - 1) * gap;
}
