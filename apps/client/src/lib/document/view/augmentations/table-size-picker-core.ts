/**
 * The pure model behind the [[Table Size Picker]] (CONTEXT.md): a columns × body-rows size,
 * grown or shrunk one step at a time and clamped to the grid the popover paints. No DOM, no
 * CodeMirror; the popover (`table-size-picker.ts`) drives this from its keymap and pointer
 * handlers.
 */

export interface TableSize {
    cols: number
    /** Body rows: the header every table has is not counted. */
    rows: number
}

/** The largest size the picker's grid offers on either axis. Bigger tables grow by Add row / Add column. */
export const TABLE_SIZE_MAX = 8

/** What the picker opens on: the size the old fixed insert produced. */
export const TABLE_SIZE_DEFAULT: TableSize = { cols: 3, rows: 2 }

export function clampTableSize(size: TableSize): TableSize {
    const clamp = (n: number) => Math.min(TABLE_SIZE_MAX, Math.max(1, Math.round(n) || 1))
    return { cols: clamp(size.cols), rows: clamp(size.rows) }
}

/** The size after moving `dCols` columns and `dRows` rows from `size`, kept within the grid. */
export function stepTableSize(size: TableSize, dCols: number, dRows: number): TableSize {
    return clampTableSize({ cols: size.cols + dCols, rows: size.rows + dRows })
}

/** The size as the picker's label reads it: "3 × 2". */
export function tableSizeLabel(size: TableSize): string {
    return `${size.cols} × ${size.rows}`
}
