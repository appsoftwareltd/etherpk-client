/**
 * Pure geometry for the protected-fence augmentation: where the atomic regions are, and which
 * edits must be refused. No CodeMirror imports — the widget and the transaction filter that use
 * this live in `protected-fence.ts`.
 *
 * ADR 0028 makes an `etherpk-cipher` fence atomic and read-only **for everyone, including the key
 * holder**. That is not a convenience: character-level editing of ciphertext is meaningless, and a
 * single stray character typed into an envelope makes it undecryptable for good. A key holder
 * edits through unlock → edit → re-encrypt, which replaces the body as one delete plus one insert.
 */
import { documentProtection } from '$lib/document/protection/cipher-fence'
import type { GuardedChange } from '$lib/document/frontmatter/boundary'

export interface ProtectedRange {
    /** Character offset of the opening fence's first character. */
    from: number
    /** Character offset just past the closing fence's last character. */
    to: number
}

/**
 * The range a [[Protected Document]]'s whole-body fence occupies in `text`, opener and closer
 * included — one range, or none. A cipher fence that is not the entire body is ordinary markdown
 * (ADR 0060) and is not listed.
 *
 * The offsets come from {@link documentProtection} rather than being recomputed here: the
 * read-only guard, the widget placement and the service's classification must all measure the
 * fence the same way, and a second computation is how a guard silently starts guarding the wrong
 * range.
 */
export function protectedRanges(text: string): ProtectedRange[] {
    const protection = documentProtection(text)
    if (protection.kind !== 'document') return []
    return protection.fences.map((fence) => ({ from: fence.from, to: fence.to }))
}

/**
 * Whether `changes` would leave a locked [[Protected Document]] no longer one: a single character
 * in front of the fence makes the fence "not the entire body", and card, guard, clamp and padlock
 * all go with that classification. Only deleting the fence whole is allowed to.
 */
export function protectionWouldVanish(before: string, changes: readonly GuardedChange[], after: () => string): boolean {
    const [fence] = protectedRanges(before)
    if (!fence) return false
    if (changes.length === 1 && changes[0].from === fence.from && changes[0].to === fence.to && changes[0].inserted === 0) {
        return false
    }
    return documentProtection(after()).kind !== 'document'
}

/**
 * Where the caret goes home to on a locked [[Protected Document]]: the end of the frontmatter's
 * last content line - after `title: Bank`, where typing is natural - not the end of the closing
 * delimiter, where every keystroke would break the block and be refused. With no frontmatter,
 * the document start. Null for a document with no whole-body fence.
 */
export function lockedCaretHome(text: string, ranges: readonly ProtectedRange[] = protectedRanges(text)): number | null {
    const fence = ranges[0]
    if (!fence) return null
    if (fence.from === 0) return 0
    // `fence.from - 1` is the newline ending the closer line; the closer starts after the newline
    // before it, and the last content line ends just before that.
    const closerStart = text.lastIndexOf('\n', fence.from - 2) + 1
    return Math.max(0, closerStart - 1)
}

/**
 * Where a caret that landed at `pos` may actually rest on a locked [[Protected Document]]: never
 * at or beyond the fence. The fence is a card, not text, and a caret parked beside it invites
 * typing into something that has no characters to type into. Anything at or past the fence goes
 * to `home` ({@link lockedCaretHome}).
 */
export function clampOutsideFence(ranges: readonly ProtectedRange[], pos: number, home: number): number {
    const fence = ranges[0]
    if (!fence || pos < fence.from) return pos
    return home
}

export interface TouchOptions {
    /**
     * Treat a change that exactly spans a whole fence as outside it. Deleting the fence whole is legitimate and needs no key — the same way any Player can delete content they
     * cannot read — while a partial deletion would corrupt the envelope.
     */
    allowWholeFence?: boolean
}

/**
 * Whether any of `changes` would edit the interior of a protected range.
 *
 * Boundaries are deliberately open: a zero-length insertion exactly at `from` or `to` is a new
 * line above or below the fence, not an edit to it, and refusing those would trap the caret
 * against a fence that starts or ends the document.
 */
export function changeTouchesProtected(
    ranges: readonly ProtectedRange[],
    changes: readonly { from: number; to: number }[],
    options: TouchOptions = {},
): boolean {
    for (const change of changes) {
        for (const range of ranges) {
            if (options.allowWholeFence && change.from === range.from && change.to === range.to) continue
            // An insertion (from === to) only counts when strictly inside; a replacement counts
            // when it overlaps the interior at all.
            const overlaps = change.from === change.to
                ? change.from > range.from && change.from < range.to
                : change.from < range.to && change.to > range.from
            if (overlaps) return true
        }
    }
    return false
}
