/**
 * The phone's top bar over the View in front rather than above it, for a View that reads better with
 * the room. The View has the top bar's height all the time, so nothing in it moves as the bar comes and
 * goes, and it clears the bar itself for whatever has to be reachable (`--top-bar-over`).
 */
import { untrack } from 'svelte'

export interface TopBarOverView {
    /** Out of sight for now. */
    readonly hidden: boolean
    /** A press on the top bar or the Command Bar. */
    pressed(): void
}

// A list, as a PDF in a drawer can open over one in the main region: the newest has the say, and when
// it goes the one beneath has it back.
let offered = $state.raw<TopBarOverView[]>([])
let opened = $state(false)

export const topBarOverView = {
    get current(): TopBarOverView | null {
        return offered.at(-1) ?? null
    },
    /** A Sidebar or the list of open documents is open, and the top bar is how a person closes it. */
    get opened(): boolean {
        return opened
    },
}

/** Put the top bar over the View until the returned function is called. Made to be an `$effect`'s body. */
export function putTopBarOverView(view: TopBarOverView): () => void {
    // Untracked, or the effect that calls this would depend on the list it changes.
    offered = [...untrack(() => offered), view]
    return () => {
        offered = untrack(() => offered).filter((each) => each !== view)
    }
}

/** The presenter's word on what is open from the top bar. */
export function noteTopBarOpened(isOpen: boolean): void {
    opened = isOpen
}
