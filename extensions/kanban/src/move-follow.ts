/**
 * Where a [[Kanban Board]] leaves the view after a move (ADR 0113). A move made with the keyboard
 * scrolls to keep the card in sight, because the keyboard goes with the card. A move made with the
 * pointer (a drag, or a row of a menu a right-click opened) leaves the board's and the lanes'
 * scroll where they were: the person is looking at the place the card left, and the board jumping
 * to another lane under the pointer was what they did not expect. When the card lands where the
 * board does not show it, the board says where it went instead, with Undo.
 *
 * Framework-free, so the arithmetic is tested in Node; the View measures the boxes.
 */
import { BOARD_LANES, BOARD_SECTIONS, type BoardCell } from './board-model'

/** A box on the screen, as `getBoundingClientRect` gives it. */
export interface Box {
    left: number
    top: number
    right: number
    bottom: number
}

/**
 * Whether a card's middle is inside every box that clips it: the lanes, which scroll sideways,
 * and its lane's body, which scrolls up and down. A card whose middle shows is one a person sees
 * arrive; a sliver at an edge is not.
 */
export function centreWithin(card: Box, clips: readonly Box[]): boolean {
    const x = (card.left + card.right) / 2
    const y = (card.top + card.bottom) / 2
    return clips.every((clip) => x >= clip.left && x <= clip.right && y >= clip.top && y <= clip.bottom)
}

const laneLabel = (cell: BoardCell) => BOARD_LANES.find((lane) => lane.status === cell.status)?.label ?? cell.status
const sectionLabel = (cell: BoardCell) => BOARD_SECTIONS.find((section) => section.priority === cell.priority)?.label ?? ''

/** What the board says about a card that moved to where it cannot be seen: where it went, in the fewest words. */
export function movedOutOfViewText(label: string, from: BoardCell, to: BoardCell): string {
    const where =
        from.status === to.status
            ? `${sectionLabel(to)} in ${laneLabel(to)}`
            : from.priority === to.priority
              ? laneLabel(to)
              : `${laneLabel(to)}, ${sectionLabel(to)}`
    return `Moved "${label}" to ${where}.`
}
