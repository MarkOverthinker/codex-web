export const TASK_GRID_GAP = 8;
export const TASK_GRID_MIN_COLUMN_WIDTH = 160;

export type TaskGridPack = {
  columns: number;
  rows: number;
};

/**
 * Pack category cards into columns from top to bottom: as long as the next
 * card fits in the current column it stays there, otherwise it starts a new
 * column. The column count never exceeds what the available width can hold,
 * so the grid falls back to vertical scrolling instead of overflowing
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
  let columns = 1;
  let rows = 0;
  let itemsInColumn = 0;
  let columnHeight = 0;
  for (const rawHeight of cardHeights) {
    const height = Math.max(0, Number.isFinite(rawHeight) ? rawHeight : 0);
    if (itemsInColumn > 0 && columnHeight + gap + height > availableHeight && columns < maxColumns) {
      columns += 1;
      itemsInColumn = 1;
      columnHeight = height;
    } else {
      columnHeight = itemsInColumn > 0 ? columnHeight + gap + height : height;
      itemsInColumn += 1;
    }
    rows = Math.max(rows, itemsInColumn);
  }
  return { columns, rows };
}
