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

    it("puts a row whose title is what was typed before one that only has it as a keyword", () => {
        // `/agent` on a task line: Copy agent instruction has "agent" in its title and its keywords,
        // and comes first in menu order, but the Agent row is the one named.
        const rows = [item('task.copyReference', 'Copy agent instruction', ['agent']), item('agent-chat.agent', 'Agent')]
        expect(rankCommandMenu(rows, 'agent').map((i) => i.id)).toEqual(['agent-chat.agent', 'task.copyReference'])
    })

    it('drops non-matches', () => {
        expect(rankCommandMenu(items, 'zzz')).toEqual([])
    })

    // The menu draws its rows under headings (Insert, Go to, Settings), so each group's rows stay
    // together whatever is typed, and the row Enter runs is still the best match.
    describe('with rows in groups', () => {
        const grouped = (id: string, title: string, group: string, keywords?: string[]): CommandMenuItem => ({ ...item(id, title, keywords), group })
        const rows = [
            grouped('table.insert', 'Table', 'Insert'),
            grouped('date.today', 'Today', 'Insert'),
            grouped('template.pick', 'Template', 'Insert', ['snippet']),
            grouped('search.open', 'Search', 'Go to', ['text']),
            grouped('journal.today', 'Open today', 'Go to'),
            grouped('spelling.languages', 'Spelling languages', 'Settings', ['search']),
        ]
        const ids = (query: string) => rankCommandMenu(rows, query).map((row) => row.id)

        it('an empty query keeps the groups in the menu’s order', () => {
            expect(ids('')).toEqual(rows.map((row) => row.id))
        })

        it('a query puts the group holding the best match first, and keeps each group together', () => {
            // Search is named; Spelling languages only has it as a keyword.
            expect(ids('search')).toEqual(['search.open', 'spelling.languages'])
            // "today" names an Insert row outright and is only part of a Go to row.
            expect(ids('today')).toEqual(['date.today', 'journal.today'])
            // "open" matches only in Go to, so no row of another group is listed.
            expect(ids('open')).toEqual(['journal.today'])
        })

        it('groups that match equally well keep the menu’s order, each with its own best match first', () => {
            const tabs = [grouped('timetable', 'Timetable', 'Insert'), grouped('table.insert', 'Table', 'Insert'), grouped('tabs.list', 'Tabs', 'Go to')]
            // Table and Tabs both start with what was typed. Insert comes first and keeps Timetable,
            // a looser match than Tabs, beside Table.
            expect(rankCommandMenu(tabs, 'tab').map((row) => row.id)).toEqual(['table.insert', 'timetable', 'tabs.list'])
        })

        it('places a row that names no group by whether it acts on the text', () => {
            const mixed = [item('agent', 'Tab agent'), grouped('table.insert', 'Table', 'Insert'), { ...item('wrap', 'Tab wrap'), actsOnText: true }]
            expect(rankCommandMenu(mixed, 'tab').map((row) => row.id)).toEqual(['table.insert', 'wrap', 'agent'])
        })
    })
})
