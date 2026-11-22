/**
 * The Find and Replace Commands (ADR 0153): open the find box, open it with the replace field, and
 * step through the matches.
 *
 * They need an editor and nothing else, so they are registered here rather than inside a
 * workspace: the graph workspace and a [[Plain Folder]]'s both use them. The request goes to the
 * find box of the View holding the focus, or the active editor while it is on screen
 * (`findOrigin`); on a journal tab that may be an older day's.
 */
import type { CommandRegistry } from '../../surface'
import { findOrigin, requestFind } from '../find/find-events'

const FIND_COMMANDS = [
    ['document.find', 'open'],
    ['document.findReplace', 'open-replace'],
    ['document.findNext', 'next'],
    ['document.findPrevious', 'previous'],
    ['document.findNextLine', 'next-line'],
    ['document.findPreviousLine', 'previous-line'],
] as const

/** Register the six find Commands. Returns a function that takes them out again. */
export function registerFindCommands(commands: CommandRegistry): () => void {
    const detach = FIND_COMMANDS.map(([id, action]) =>
        commands.register(id, () => {
            const origin = findOrigin()
            if (origin) requestFind(origin, action)
        }),
    )
    return () => detach.forEach((off) => off())
}
