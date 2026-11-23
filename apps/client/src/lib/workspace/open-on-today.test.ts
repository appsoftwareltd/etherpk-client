import { describe, expect, it } from 'vitest'

import type { ViewInstance } from '#lib/layout/index.js'

import { staleJournalDrafts } from './open-on-today'

const doc = (target: string, more: Partial<ViewInstance> = {}): ViewInstance => ({ panelId: `document:${target}`, view: { kind: 'document', target }, ...more })
const stale = (views: ViewInstance[], entries: string[] = []) => staleJournalDrafts(views, { today: '2026-03-10', hasEntry: (day) => entries.includes(day) })

describe('the tabs a graph opening on today lets go', () => {
    it('are the earlier days nothing was written for', () => {
        expect(stale([doc('2026-03-08'), doc('2026-03-09'), doc('2026-03-10')], ['2026-03-08'])).toEqual(['document:2026-03-09'])
    })

    it('never a pinned one', () => {
        expect(stale([doc('2026-03-09', { pinned: true })])).toEqual([])
    })

    it('never today, a later day, or a page', () => {
        expect(stale([doc('2026-03-10'), doc('2026-03-11'), doc('Garden'), doc('2026-03-09 Garden')])).toEqual([])
    })

    it('never a View that is not a document, such as a past day’s versions', () => {
        expect(stale([{ panelId: 'version-history:2026-03-09', view: { kind: 'version-history', target: '2026-03-09' } }])).toEqual([])
    })
})
