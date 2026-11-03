/**
 * What a pointer pressed on the board does, decided from the pointer alone, so every rule is
 * checked in Node:
 *
 * - **Pen mode.** Once a pen has touched this board, a finger only pans and zooms, never draws: a
 *   hand resting on a tablet's screen while writing leaves no marks (palm rejection). Before any
 *   pen is seen, one finger uses the tool, so a phone without a stylus can still draw.
 * - **A pen's eraser end** (or its eraser button) erases, whatever tool is chosen.
 * - **Panning**: the Hand tool, the middle button, Space held down while dragging, a second
 *   finger, and any pointer on a board that cannot be written.
 *
 * The approach follows the pen-first input handling of Quickdraw (`@quickdrawjs/core`, MIT
 * License); no code is taken from it.
 */

export type BoardTool = 'hand' | 'pen' | 'highlighter' | 'eraser' | 'lasso'

export type PointerIntent = 'draw' | 'erase' | 'lasso' | 'pan' | 'pinch' | 'ignore'

export interface PointerFacts {
    pointerType: string
    /** The button that went down (`PointerEvent.button`): 0 main, 1 middle, 2 secondary, 5 a pen's eraser. */
    button: number
    /** The buttons held (`PointerEvent.buttons`): 32 is a pen's eraser. */
    buttons: number
    /** Whether Space is held down. */
    spaceHeld: boolean
    /** Whether a pen has been seen on this board. */
    penSeen: boolean
    /** How many other fingers are on the board already. */
    otherTouches: number
    /** Whether the board can be written. */
    writable: boolean
    tool: BoardTool
}

/** Whether a pointer is a pen's eraser end or a pen with its eraser button held. */
export function isPenEraser(facts: Pick<PointerFacts, 'pointerType' | 'button' | 'buttons'>): boolean {
    return facts.pointerType === 'pen' && (facts.button === 5 || (facts.buttons & 32) !== 0)
}

/** What a pointer that went down on the board does. */
export function pointerIntent(facts: PointerFacts): PointerIntent {
    if (facts.pointerType === 'touch') {
        if (facts.otherTouches > 0) return 'pinch'
        if (facts.penSeen || !facts.writable || facts.spaceHeld || facts.tool === 'hand') return 'pan'
        return toolIntent(facts.tool)
    }
    if (facts.button === 2) return 'ignore'
    if (facts.button === 1 || facts.spaceHeld || !facts.writable || facts.tool === 'hand') return 'pan'
    if (isPenEraser(facts)) return 'erase'
    if (facts.button !== 0) return 'ignore'
    return toolIntent(facts.tool)
}

function toolIntent(tool: BoardTool): PointerIntent {
    if (tool === 'hand') return 'pan'
    if (tool === 'eraser') return 'erase'
    if (tool === 'lasso') return 'lasso'
    return 'draw'
}

/** What a key pressed on the board does, or null for a key the board leaves alone. */
export type BoardKey = { tool: BoardTool } | 'delete-selection' | 'clear-selection' | null

export function boardKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>, writable: boolean): BoardKey {
    if (event.ctrlKey || event.metaKey || event.altKey || !writable) return null
    switch (event.key.toLowerCase()) {
        case 'h':
            return { tool: 'hand' }
        case 'p':
            return { tool: 'pen' }
        case 'm':
            return { tool: 'highlighter' }
        case 'e':
            return { tool: 'eraser' }
        case 'l':
            return { tool: 'lasso' }
        case 'delete':
        case 'backspace':
            return 'delete-selection'
        case 'escape':
            return 'clear-selection'
        default:
            return null
    }
}

/** The pressure a point is kept with: a pen's own, or none (0.5) for a mouse or a finger. */
export function pointPressure(pointerType: string, pressure: number): number {
    if (pointerType !== 'pen') return 0.5
    // A pen reports 0 on the instant it lands on some tablets: keep a trace of ink rather than none.
    return Math.min(1, Math.max(0.05, pressure))
}
