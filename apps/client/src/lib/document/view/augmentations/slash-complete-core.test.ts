import { describe, expect, it } from 'vitest'

import type { CommandMenuItem } from '../../../surface'
import { openSlashContext, rankCommandMenu } from './slash-complete-core'

describe('openSlashContext', () => {
    it('triggers when `/` starts the line content', () => {
        expect(openSlashContext('/tod')).toEqual({ slash: 0, queryFrom: 1, query: 'tod' })
    })

    it('triggers after whitespace and reports the `/` column', () => {
        expect(openSlashContext('hello /tab')).toEqual({ slash: 6, queryFrom: 7, query: 'tab' })
    })

    it('triggers behind a leading indent and after a bullet marker', () => {
        expect(openSlashContext('  /today')).toEqual({ slash: 2, queryFrom: 3, query: 'today' })
        expect(openSlashContext('- /today')).toEqual({ slash: 2, queryFrom: 3, query: 'today' })
    })

    it('does not trigger mid-word (http://, and/or, dates)', () => {
        expect(openSlashContext('http://')).toBeNull()
        expect(openSlashContext('and/or')).toBeNull()
        expect(openSlashContext('see 24/06')).toBeNull()
        expect(openSlashContext('foo/')).toBeNull()
    })

    it('bare `/` has an empty query (lists everything)', () => {
        expect(openSlashContext('/')).toEqual({ slash: 0, queryFrom: 1, query: '' })
        expect(openSlashContext('text /')).toEqual({ slash: 5, queryFrom: 6, query: '' })
    })

    it('closes once a space follows the query', () => {
        expect(openSlashContext('/today now')).toBeNull()
    })
})

describe('rankCommandMenu', () => {
    const item = (id: string, title: string, keywords?: string[]): CommandMenuItem => ({
        id,
        title,
        command: `cmd.${id}`,
        keywords,
    })
    const items = [
        item('date.today', 'Today'),
        item('date.pick', 'Date Picker', ['calendar']),
        item('table.insert', 'Table'),
        item('table.addRow', 'Table: Add row'),
    ]

    it('empty query keeps registration order (grouped)', () => {
        expect(rankCommandMenu(items, '').map((i) => i.id)).toEqual([
            'date.today',
            'date.pick',
            'table.insert',
            'table.addRow',
        ])
    })

    it('fuzzy-matches across the title without typing spaces', () => {
        // "tar" subsequence-matches "Table: Add row"
        const ids = rankCommandMenu(items, 'tar').map((i) => i.id)
        expect(ids).toContain('table.addRow')
    })

    it('ranks an exact/prefix match above a looser one', () => {
        const ids = rankCommandMenu(items, 'tab').map((i) => i.id)
        // "Table" (prefix) outranks "Table: Add row" (also prefix but longer) — both kept
        expect(ids[0]).toBe('table.insert')
        expect(ids).toContain('table.addRow')
    })

    it('matches via a keyword', () => {
        const ids = rankCommandMenu(items, 'calendar').map((i) => i.id)
        expect(ids).toEqual(['date.pick'])
    })

    it('drops non-matches', () => {
        expect(rankCommandMenu(items, 'zzz')).toEqual([])
    })
})
