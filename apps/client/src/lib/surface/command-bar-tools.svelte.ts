/**
 * A tab's own tools on the **Command Bar** (CONTEXT.md → Command Bar). A PDF's buttons act on what its
 * tab holds, so they stay that tab's markup and handlers rather than becoming Commands: the tab hands
 * the bar snippets to draw. While a tab's tools are there, the bar shows nothing else but the
 * contributed buttons that name the tab's type of file.
 */
import { untrack, type Snippet } from 'svelte'

export interface CommandBarTools {
    /** The type of file (`pdf`), which a contributed button names in `files` to stay beside these. */
    file: string
    /** Drawn in the strip that scrolls. */
    strip: Snippet
    /** Drawn at the start of the pinned group. */
    pinned: Snippet
}

// A list, as a PDF in a drawer can open over one in the main region: the newest has the bar, and when
// it goes the one beneath has it back.
let offered = $state.raw<CommandBarTools[]>([])

export const commandBarTools = {
    get current(): CommandBarTools | null {
        return offered.at(-1) ?? null
    },
}

/** Put a tab's tools on the bar until the returned function is called. Made to be an `$effect`'s body. */
export function offerCommandBarTools(tools: CommandBarTools): () => void {
    // Untracked, or the effect that calls this would depend on the list it changes.
    offered = [...untrack(() => offered), tools]
    return () => {
        offered = untrack(() => offered).filter((each) => each !== tools)
    }
}
