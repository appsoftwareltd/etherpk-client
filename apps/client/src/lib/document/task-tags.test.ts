import { describe, expect, it } from 'vitest'

import { applyTaskTag, parseTaskLine, parseTaskTags, taskTagRun, toggleTaskLine } from './task-tags'

describe('parseTaskTags', () => {
    it('reads the full minted tag set from the leading run', () => {
        const tags = parseTaskTags('#P1 #W #D #D-2026-09-15 #C-2026-09-20 #S-2026-09-10 Ship it')
        expect(tags).toEqual({
            priority: 1,
            waiting: true,
            doing: true,
            cancelled: false,
            due: '2026-09-15',
            completion: '2026-09-20',
            scheduled: '2026-09-10',
            text: 'Ship it',
        })
    })

    it('stops at the first non-tag token, so hash text in prose is never metadata', () => {
        const tags = parseTaskTags('#P1 triage the #P2 backlog #W')
        expect(tags.priority).toBe(1)
        // The trailing #W came AFTER prose, so it is prose.
        expect(tags.waiting).toBe(false)
        expect(tags.text).toBe('triage the #P2 backlog #W')
    })

    it('is case-sensitive: lowercase priority is prose', () => {
        const tags = parseTaskTags('#p1 lower case')
        expect(tags.priority).toBeNull()
        expect(tags.text).toBe('#p1 lower case')
    })

    it('lets the first of a kind win without ending the run', () => {
        const tags = parseTaskTags('#P1 #P3 #W Fix it')
        expect(tags.priority).toBe(1)
        expect(tags.waiting).toBe(true)
        expect(tags.text).toBe('Fix it')
    })

    it('treats a date-shaped tag as a date without validating the calendar', () => {
        expect(parseTaskTags('#D-2026-13-45 odd').due).toBe('2026-13-45')
    })

    it('ends the run on a malformed date rather than swallowing it', () => {
        const tags = parseTaskTags('#D-tomorrow buy milk')
        expect(tags.due).toBeNull()
        expect(tags.text).toBe('#D-tomorrow buy milk')
    })

    it('returns an all-empty result with untouched text when there are no tags', () => {
        expect(parseTaskTags('Buy milk')).toEqual({
            priority: null,
            waiting: false,
            doing: false,
            cancelled: false,
            due: null,
            completion: null,
            scheduled: null,
            text: 'Buy milk',
        })
    })

    it('handles a task that is nothing but tags', () => {
        expect(parseTaskTags('#P2 #W').text).toBe('')
    })
})

describe('parseTaskLine', () => {
    it('reads the checkbox and the tags off a raw source line', () => {
        expect(parseTaskLine('  - [x] #P2 #C Dropped')).toMatchObject({
            done: true,
            priority: 2,
            cancelled: true,
            text: 'Dropped',
        })
    })

    it('tells bare #C (cancelled) from dated #C- (completion)', () => {
        expect(parseTaskLine('- [x] #C-2026-09-01 Shipped')).toMatchObject({
            cancelled: false,
            completion: '2026-09-01',
            text: 'Shipped',
        })
    })

    it('tells bare #D (doing) from dated #D- (due)', () => {
        expect(parseTaskLine('- [ ] #D Drafting')).toMatchObject({ doing: true, due: null, text: 'Drafting' })
        expect(parseTaskLine('- [ ] #D-2026-09-15 Ship')).toMatchObject({
            doing: false,
            due: '2026-09-15',
            text: 'Ship',
        })
    })

    it('does not read the words the states were minted as (ADR 0032): they are prose', () => {
        expect(parseTaskLine('- [ ] #doing Drafting')).toMatchObject({ doing: false, text: '#doing Drafting' })
        expect(parseTaskLine('- [x] #cancelled Dropped')).toMatchObject({
            cancelled: false,
            text: '#cancelled Dropped',
        })
    })

    it('returns null for lines that are not tasks', () => {
        expect(parseTaskLine('- a plain bullet')).toBeNull()
        expect(parseTaskLine('# A heading')).toBeNull()
        expect(parseTaskLine('')).toBeNull()
    })
})

describe('taskTagRun', () => {
    /** The run as the text it covers, which is what a failure message needs to show. */
    const run = (line: string) => {
        const span = taskTagRun(line)
        return span && line.slice(span.from, span.to)
    }

    it('covers the leading tags and nothing after them', () => {
        expect(run('- [ ] #P1 #D-2026-07-01 Ship the release')).toBe('#P1 #D-2026-07-01')
        expect(run('  - [x] #W   waiting on Sam')).toBe('#W')
    })

    it('covers a run with no text after it', () => {
        expect(run('- [ ] #P2')).toBe('#P2')
        expect(run('- [ ] #P2 ')).toBe('#P2')
    })

    it('is null for a task without tags, a hash word in prose, and a line that is not a task', () => {
        expect(taskTagRun('- [ ] Ship it')).toBeNull()
        expect(taskTagRun('- [ ] Ship #P1 later')).toBeNull()
        expect(taskTagRun('- plain #P1 bullet')).toBeNull()
        expect(taskTagRun('- [ ]')).toBeNull()
    })
})

describe('toggleTaskLine', () => {
    it('flips the checkbox and changes nothing else', () => {
        expect(toggleTaskLine('    - [ ] #P1 Fix the login redirect', true)).toBe(
            '    - [x] #P1 Fix the login redirect',
        )
        expect(toggleTaskLine('- [X] Done already', false)).toBe('- [ ] Done already')
    })

    it('refuses a line that is not a task', () => {
        expect(toggleTaskLine('- a plain bullet', true)).toBeNull()
    })
})

describe('applyTaskTag', () => {
    it('sets a tag into the leading run, ahead of the text', () => {
        expect(applyTaskTag('- [ ] Fix the redirect', { kind: 'priority', value: 1 })).toBe(
            '- [ ] #P1 Fix the redirect',
        )
    })

    it('removes a state tag that is issued again, so one row both sets and clears', () => {
        expect(applyTaskTag('- [ ] #P1 Fix it', { kind: 'priority', value: 1 })).toBe('- [ ] Fix it')
        expect(applyTaskTag('- [ ] #W Chase Bob', { kind: 'waiting' })).toBe('- [ ] Chase Bob')
        expect(applyTaskTag('- [ ] Chase Bob', { kind: 'waiting' })).toBe('- [ ] #W Chase Bob')
        expect(applyTaskTag('- [ ] Draft it', { kind: 'doing' })).toBe('- [ ] #D Draft it')
        expect(applyTaskTag('- [ ] #D Draft it', { kind: 'doing' })).toBe('- [ ] Draft it')
    })

    it('replaces a different priority rather than leaving both', () => {
        // Only the first of a kind counts (ADR 0032), so keeping both would ignore one.
        expect(applyTaskTag('- [ ] #P1 Fix it', { kind: 'priority', value: 3 })).toBe('- [ ] #P3 Fix it')
    })

    it('replaces a date tag of the same kind, and keeps the others', () => {
        expect(
            applyTaskTag('- [ ] #D-2026-01-01 #S-2026-02-02 Ship', { kind: 'due', value: '2026-09-15' }),
        ).toBe('- [ ] #S-2026-02-02 #D-2026-09-15 Ship')
    })

    it('writes the run in a fixed order however it was set', () => {
        const once = applyTaskTag('- [ ] #W #P2 Ship', { kind: 'doing' })
        expect(once).toBe('- [ ] #P2 #W #D Ship')
    })

    it('preserves indentation and the checkbox state', () => {
        expect(applyTaskTag('    - [x] Done thing', { kind: 'priority', value: 2 })).toBe(
            '    - [x] #P2 Done thing',
        )
    })

    it('leaves no trailing space on a task that has tags but no text yet', () => {
        expect(applyTaskTag('- [ ] ', { kind: 'priority', value: 1 })).toBe('- [ ] #P1')
    })

    it('refuses a line that is not a task', () => {
        expect(applyTaskTag('- a plain bullet', { kind: 'waiting' })).toBeNull()
    })
})
