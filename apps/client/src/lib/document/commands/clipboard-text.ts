/**
 * Put text on the system clipboard, or reject with a reason a person can act on.
 *
 * The async clipboard exists only in a secure context: on a plain-http host other than
 * localhost `navigator.clipboard` is undefined, and calling through it would throw a TypeError
 * that tells the user nothing. This rejects with the actual reason instead, for the caller to
 * put in its "Could not copy…" notice.
 *
 * Call it from the activating click's own handler with no `await` before it. The write starts
 * synchronously inside this function, and Safari and Firefox refuse one once the user
 * activation has passed.
 */
export async function writeClipboardText(text: string): Promise<void> {
    if (!navigator.clipboard) {
        throw new Error('the browser offers no clipboard on this origin (it needs https or localhost)')
    }
    await navigator.clipboard.writeText(text)
}

/**
 * The notice for a copy that failed: what was being copied, why it failed, and the text itself,
 * so it can still be copied by hand. `what` names the thing ("name", "file path").
 *
 * The browser's reason usually ends with a full stop ("Write permission denied."), which is
 * dropped so the sentence after it does not start with two.
 */
export function copyFailureMessage(what: string, err: unknown, text: string): string {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\.+$/, '')
    return `Could not copy the ${what}: ${reason}. Copy it by hand: ${text}`
}
