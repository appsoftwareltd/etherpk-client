import { describe, expect, it } from 'vitest'

import { parseLogseqTask, orgTimestampDate } from './logseq-tasks'
import { convertObsidianTaskLine } from './obsidian-tasks'
import { leadingTagRun, taskLine } from './task-tags'
import type { ReportEntry } from './types'

describe('leadingTagRun / taskLine', () => {
    it('emits tags in the canonical order', () => {
        expect(
            leadingTagRun({
                priority: 2,
                waiting: true,
                due: '2026-03-20',
                scheduled: '2026-03-18',
                completed: '2026-03-21',
            }),
        ).toBe('#P2 #W #D-2026-03-20 #S-2026-03-18 #C-2026-03-21')
    })

    it('assembles a task line with the run leading, before any prose', () => {
        expect(taskLine('  ', '-', false, { priority: 1 }, 'fix the bug')).toBe(
            '  - [ ] #P1 fix the bug',
        )
    })

    it('emits a bare checkbox when there are no tags', () => {
        expect(taskLine('', '-', true, {}, 'done thing')).toBe('- [x] done thing')
    })
})

describe('parseLogseqTask', () => {
    it('returns null for a non-task bullet', () => {
        expect(parseLogseqTask('just some text')).toBeNull()
        expect(parseLogseqTask('TODOish word')).toBeNull()
    })

    it.each([
        ['TODO write it', false, {}, 'write it'],
        ['LATER write it', false, {}, 'write it'],
        ['NOW write it', false, { doing: true }, 'write it'],
        ['DOING write it', false, { doing: true }, 'write it'],
        ['WAITING on Bob', false, { waiting: true }, 'on Bob'],
        ['DONE shipped', true, {}, 'shipped'],
        ['CANCELED abandoned', true, { cancelled: true }, 'abandoned'],
        ['CANCELLED abandoned', true, { cancelled: true }, 'abandoned'],
    ])('parses %s', (content, done, tags, text) => {
        expect(parseLogseqTask(content)).toEqual({ done, tags, text })
    })

    it('parses the [#A]/[#B]/[#C] priority after the marker', () => {
        expect(parseLogseqTask('TODO [#A] critical')).toEqual({
            done: false,
            tags: { priority: 1 },
            text: 'critical',
        })
        expect(parseLogseqTask('DONE [#C] normal')).toEqual({
            done: true,
            tags: { priority: 3 },
            text: 'normal',
        })
    })

    it('extracts the ISO date from org timestamps, repeaters and times included', () => {
        expect(orgTimestampDate('DEADLINE: <2026-03-20 Fri>')).toBe('2026-03-20')
        expect(orgTimestampDate('SCHEDULED: <2026-03-18 Wed 10:00 .+1w>')).toBe('2026-03-18')
        expect(orgTimestampDate('no timestamp')).toBeNull()
    })
})

describe('convertObsidianTaskLine', () => {
    const convert = (line: string) => {
        const report: ReportEntry[] = []
        return { line: convertObsidianTaskLine(line, 'Note', report), report }
    }

    it('leaves non-task lines untouched', () => {
        expect(convert('plain prose').line).toBe('plain prose')
        expect(convert('- a bullet').line).toBe('- a bullet')
    })

    it('keeps plain checkboxes as they are', () => {
        expect(convert('- [ ] open task').line).toBe('- [ ] open task')
        expect(convert('- [x] done task').line).toBe('- [x] done task')
    })

    it('converts Tasks-plugin due, scheduled, and done dates into leading tags', () => {
        expect(convert('- [ ] pay the bill 📅 2026-03-20').line).toBe(
            '- [ ] #D-2026-03-20 pay the bill',
        )
        expect(convert('- [x] report ✅ 2026-03-21 📅 2026-03-20').line).toBe(
            '- [x] #D-2026-03-20 #C-2026-03-21 report',
        )
        expect(convert('- [ ] prep ⏳ 2026-03-18').line).toBe('- [ ] #S-2026-03-18 prep')
    })

    it('maps priorities and drops below-normal ones with a report entry', () => {
        expect(convert('- [ ] urgent 🔺').line).toBe('- [ ] #P1 urgent')
        expect(convert('- [ ] high ⏫').line).toBe('- [ ] #P2 high')
        expect(convert('- [ ] medium 🔼').line).toBe('- [ ] #P3 medium')
        const low = convert('- [ ] low 🔽')
        expect(low.line).toBe('- [ ] low')
        expect(low.report).toHaveLength(1)
        expect(low.report[0].category).toBe('drop')
    })

    it('folds a start date into #S- only when no scheduled date is present', () => {
        expect(convert('- [ ] trip 🛫 2026-03-15').line).toBe('- [ ] #S-2026-03-15 trip')
        const both = convert('- [ ] trip 🛫 2026-03-15 ⏳ 2026-03-18')
        expect(both.line).toBe('- [ ] #S-2026-03-18 trip')
        expect(both.report.some((r) => r.detail.includes('Start date'))).toBe(true)
    })

    it('degrades in-progress and cancelled checkbox states to minted tags', () => {
        expect(convert('- [/] underway').line).toBe('- [ ] #D underway')
        expect(convert('- [-] abandoned').line).toBe('- [x] #C abandoned')
    })

    it('degrades unknown checkbox states to open with a report entry', () => {
        const fwd = convert('- [>] forwarded')
        expect(fwd.line).toBe('- [ ] forwarded')
        expect(fwd.report[0].category).toBe('degradation')
    })

    it('drops created dates and leaves recurrence in place, both reported', () => {
        const created = convert('- [ ] thing ➕ 2026-03-10')
        expect(created.line).toBe('- [ ] thing')
        expect(created.report[0].detail).toContain('➕')
        const rec = convert('- [ ] water plants 🔁 every week 📅 2026-03-20')
        expect(rec.line).toBe('- [ ] #D-2026-03-20 water plants 🔁 every week')
        expect(rec.report.some((r) => r.category === 'unsupported')).toBe(true)
    })

    it('preserves indentation and the * bullet', () => {
        expect(convert('  * [ ] nested 📅 2026-03-20').line).toBe(
            '  * [ ] #D-2026-03-20 nested',
        )
    })
})
