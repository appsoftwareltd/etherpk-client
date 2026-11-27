/**
 * Putting a page's address on the clipboard. A clipboard write shows nothing, so a refusal is told
 * as a notice; a success is confirmed by whoever asked, in place where it can be (the field's
 * button turns to a tick) and as a notice where nothing on the screen changed (a Command).
 */
import { showNotice } from '#lib/activity/notices.js'
import { THE_ASKER } from '#lib/native/place.js'

/** The notice's id: one copy's outcome replaces the one before. */
const NOTICE_ID = 'page-link-copy'

/** Copy `text`, named `what` in a refusal ("the link to this page"). Resolves with whether it landed. */
export async function copyPageAddress(text: string, what: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch (error) {
        console.error(`[page-address] could not copy ${what}`, error)
        const asker = THE_ASKER.charAt(0).toUpperCase() + THE_ASKER.slice(1)
        showNotice({ id: NOTICE_ID, tone: 'error', text: `Could not copy ${what}. ${asker} did not allow it: try again.` })
        return false
    }
}

/** Say that the link landed, for a copy with nothing on the screen to show it. */
export function sayLinkCopied(): void {
    showNotice({ id: NOTICE_ID, tone: 'info', text: 'Copied a link to this page.' })
}
