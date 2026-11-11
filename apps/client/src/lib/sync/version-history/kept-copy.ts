/**
 * The sentence a delete confirmation ends with (ADR 0184): how long a synced graph keeps what is
 * deleted, or that the delete cannot be undone. `keptDays` is absent on a Filesystem graph, 0 where
 * the Sync Server keeps nothing, and `unknown` while the period is being read.
 */
export function deleteOutcomeSentence(keptDays: number | 'unknown' | undefined): string {
    if (keptDays === undefined || keptDays === 0) return 'This cannot be undone.'
    if (keptDays === 'unknown') return 'Any member can restore it from All Documents for a while.'
    return `Any member can restore it from All Documents for ${keptDays} ${keptDays === 1 ? 'day' : 'days'}.`
}

/**
 * The question a PDF's or an EBook's tab asks before deleting it. `notes` names what the person
 * wrote on it ("3 annotations"), which goes with the file on a Filesystem graph and is kept with it
 * on a synced one while the file is.
 */
export function deleteFileQuestion(name: string, notes: string | null, keptDays: number | 'unknown' | undefined): string {
    const kept = keptDays !== undefined && keptDays !== 0
    const withNotes = notes ? `, with your ${notes}` : ''
    return `Delete ${name}${kept ? '' : ', permanently'}${withNotes}? ${deleteOutcomeSentence(keptDays)}`
}

/** The period a view reads from the open graph's Version History, undefined where there is none. */
export async function keptDaysOf(versions: { policy(): Promise<{ retentionDays: number }> } | undefined): Promise<number | 'unknown' | undefined> {
    if (!versions) return undefined
    return versions.policy().then((policy) => policy.retentionDays, () => 'unknown' as const)
}
