import { describe, expect, it } from 'vitest'
import type { VersionListEntry } from '@appsoftwareltd/etherpk-shared'
import { changeSummary, groupByDay, policyNotice, reasonLabel } from './version-history-copy'

const entry = (createdAt: string, versionId: string): VersionListEntry => ({ versionId, createdAt, reason: 'idle', bytes: 10, epochId: 1 })

describe('version history copy (ADR 0184)', () => {
    it('names what made each version', () => {
        expect(reasonLabel('idle')).toBe('Edited')
        expect(reasonLabel('before_delete')).toBe('Before it was deleted')
        expect(reasonLabel('before_agent_write')).toBe('Before an agent’s edit')
    })

    it('groups versions into local days, newest first, with today and yesterday by name', () => {
        const now = new Date(2026, 10, 11, 15, 0)
        const days = groupByDay(
            [
                entry(new Date(2026, 10, 10, 9, 0).toISOString(), 'b'),
                entry(new Date(2026, 10, 11, 14, 0).toISOString(), 'a2'),
                entry(new Date(2026, 10, 11, 9, 0).toISOString(), 'a1'),
                entry(new Date(2026, 10, 3, 9, 0).toISOString(), 'c'),
            ],
            now,
        )
        expect(days.map((day) => day.label.startsWith('Today') || day.label.startsWith('Yesterday') ? day.label : 'date')).toEqual([
            'Today',
            'Yesterday',
            'date',
        ])
        expect(days[0].versions.map((v) => v.versionId)).toEqual(['a2', 'a1'])
    })

    it('says what the retention period means: kept, paused, reducing, or off', () => {
        expect(policyNotice({ retentionDays: 30, reduction: null, removalPaused: false })).toBe(
            'Earlier versions, deleted documents and deleted files are kept for 30 days.',
        )
        expect(policyNotice({ retentionDays: 30, reduction: null, removalPaused: true })).toContain('Nothing is removed while the graph owner’s plan is inactive.')
        expect(policyNotice({ retentionDays: 365, reduction: { toDays: 30, from: '2026-12-11T00:00:00.000Z' }, removalPaused: false })).toContain(
            'anything older than 30 days will be removed',
        )
        expect(policyNotice({ retentionDays: 0, reduction: null, removalPaused: false })).toBe(
            'This Sync Server keeps no earlier versions, and a delete is permanent.',
        )
    })

    it('sums up a version’s changes against the version before it', () => {
        const before = 'today at 13:50'
        expect(changeSummary({ added: 2, removed: 1 }, before)).toBe('2 lines added and 1 removed since the version from today at 13:50.')
        expect(changeSummary({ added: 1, removed: 0 }, before)).toBe('1 line added since the version from today at 13:50.')
        expect(changeSummary({ added: 0, removed: 3 }, before)).toBe('3 lines removed since the version from today at 13:50.')
        expect(changeSummary({ added: 0, removed: 0 }, before)).toBe('The text is the same as in the version from today at 13:50.')
    })
})
