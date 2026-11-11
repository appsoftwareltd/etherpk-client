/**
 * The words Version History shows (ADR 0184): what made each version, how the list is grouped,
 * and what the retention period means for the person reading it. Pure, so it is tested here and
 * the views only lay it out.
 */
import type { VersionListEntry, VersionPolicy, VersionReason } from '@appsoftwareltd/etherpk-shared'

const REASONS: Record<VersionReason, string> = {
    idle: 'Edited',
    before_delete: 'Before it was deleted',
    before_rename: 'Before a rename',
    before_replace_all: 'Before Replace all',
    before_unprotect: 'Before protection was removed',
    before_restore: 'Before a restore',
    before_agent_write: 'Before an agent’s edit',
}

/** What made a version, in the person's terms. */
export function reasonLabel(reason: VersionReason): string {
    return REASONS[reason]
}

export interface VersionDay {
    /** `Today`, `Yesterday`, or the date. */
    label: string
    versions: VersionListEntry[]
}

const sameYearDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const otherYearDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function dayKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Versions in local days, newest first; `now` is read by the caller at the moment of use. */
export function groupByDay(versions: readonly VersionListEntry[], now: Date): VersionDay[] {
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const days: VersionDay[] = []
    let current: VersionDay | null = null
    let currentKey = ''
    const sorted = [...versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    for (const version of sorted) {
        const date = new Date(version.createdAt)
        const key = dayKey(date)
        if (!current || key !== currentKey) {
            const label =
                key === dayKey(now)
                    ? 'Today'
                    : key === dayKey(yesterday)
                      ? 'Yesterday'
                      : (date.getFullYear() === now.getFullYear() ? sameYearDay : otherYearDay).format(date)
            current = { label, versions: [] }
            currentKey = key
            days.push(current)
        }
        current.versions.push(version)
    }
    return days
}

/** A version's time of day, as its row shows it. */
export function versionTime(createdAt: string): string {
    return time.format(new Date(createdAt))
}

/** A moment in the person's terms: `14:02` today, else the date and time. */
export function versionMoment(createdAt: string, now: Date): string {
    const date = new Date(createdAt)
    if (dayKey(date) === dayKey(now)) return `today at ${time.format(date)}`
    return `${(date.getFullYear() === now.getFullYear() ? sameYearDay : otherYearDay).format(date)}, ${time.format(date)}`
}

const longDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

function days(n: number): string {
    return `${n} ${n === 1 ? 'day' : 'days'}`
}

/** What the retention period means now, for the top of the history and the settings. */
export function policyNotice(policy: VersionPolicy): string {
    if (policy.retentionDays === 0 && !policy.reduction) {
        return 'This Sync Server keeps no earlier versions, and a delete is permanent.'
    }
    const kept = `Earlier versions, deleted documents and deleted files are kept for ${days(policy.retentionDays)}.`
    if (policy.removalPaused) {
        return `${kept} Nothing is removed while the graph owner’s plan is inactive.`
    }
    if (policy.reduction) {
        const from = longDate.format(new Date(policy.reduction.from))
        return policy.reduction.toDays === 0
            ? `${kept} From ${from} nothing will be kept, after a change to the graph owner’s plan.`
            : `${kept} From ${from}, after a change to the graph owner’s plan, anything older than ${days(policy.reduction.toDays)} will be removed.`
    }
    return kept
}

/** When something kept goes, for a deleted item's row. */
export function removalNotice(removeAt: string | null): string {
    if (removeAt === null) return 'Kept while the graph owner’s plan is inactive'
    return `Removed on ${longDate.format(new Date(removeAt))}`
}

/** What a restore that wrote nothing says, in the person's terms. */
export function restoreRefusal(kind: 'read-only' | 'unconfirmed' | 'name-taken', name?: string): string {
    if (kind === 'read-only') return "Could not restore: the graph owner's plan does not allow changes at the moment."
    if (kind === 'name-taken') return `Could not restore: another document is now called "${name}".`
    return 'Could not restore: it could not be brought up to date with the Sync Server. Check the connection and try again.'
}

/** What a restore that worked says, `lead` first, then any file it shows that has gone for good. */
export function restoredMessage(lead: string, missingFiles: number): string {
    if (missingFiles === 0) return lead
    return `${lead} ${missingFiles} ${missingFiles === 1 ? 'file it shows has' : 'files it shows have'} been removed for good and will show as missing.`
}

function lines(n: number): string {
    return `${n} ${n === 1 ? 'line' : 'lines'}`
}

/** A version's changes in a sentence, against the version before it, made at `beforeMoment`. */
export function changeSummary(counts: { added: number; removed: number }, beforeMoment: string): string {
    const since = `since the version from ${beforeMoment}.`
    if (counts.added > 0 && counts.removed > 0) return `${lines(counts.added)} added and ${counts.removed} removed ${since}`
    if (counts.added > 0) return `${lines(counts.added)} added ${since}`
    if (counts.removed > 0) return `${lines(counts.removed)} removed ${since}`
    return `The text is the same as in the version from ${beforeMoment}.`
}

/** When this device keeps a version, under the list, so the list's gaps make sense. */
export const WHEN_VERSIONS_ARE_KEPT =
    'A version is kept when you pause editing, at most every 10 minutes, when you close the document or leave EtherPK, and before a delete, a rename, Replace all or a restore.'
