import { describe, expect, it } from 'vitest'

import { applyStrayTaskTags, applyTaskTag, freeTagsIn, parseTaskLine, parseTaskTags, taskDisplay, taskLineWith, taskStatus, taskTagRun, taskTagTokens, toggleTaskLine, withoutFreeTags } from './task-tags'

/** The state flags switched off: for comparing two readings by what {@link taskStatus} makes of them instead. */
const STATES_OFF = { waiting: false, doing: false, test: false, cancelled: false, archived: false }

describe('parseTaskTags', () => {
    it('reads the full minted tag set from the leading run', () => {
        const tags = parseTaskTags('#P1 #W #D #D-2026-09-15 #C-2026-09-20 #S-2026-09-10 Ship it')
        expect(tags).toEqual({
            priority: 1,
            waiting: true,
            doing: true,
            test: false,
            cancelled: false,
            archived: false,
            due: '2026-09-15',
            completion: '2026-09-20',
            scheduled: '2026-09-10',
            text: 'Ship it',
        })
    })

    it('ends the run at the first token that is not a tag, and reads a Task Tag written after it too', () => {
        const tags = parseTaskTags('#P1 triage the #P2 backlog #W')
        // Read as tidy on leave would write them: the later priority replaces the run's.
        expect(tags.priority).toBe(2)
        expect(tags.waiting).toBe(true)
        expect(tags.text).toBe('triage the backlog')
    })

    it('reads a tag in any case', () => {
        expect(parseTaskTags('#p1 #w #d #t #c #a #d-2026-09-15 #c-2026-09-20 #s-2026-09-10 Ship it')).toEqual({
            priority: 1,
            waiting: true,
            doing: true,
            test: true,
            cancelled: true,
            archived: true,
            due: '2026-09-15',
            completion: '2026-09-20',
            scheduled: '2026-09-10',
            text: 'Ship it',
        })
    })

    it('lets the first of a kind win whatever the case of each', () => {
        expect(parseTaskTags('#p2 #P1 Fix it')).toMatchObject({ priority: 2, text: 'Fix it' })
    })

    it('reads only the known tags in any case: anything else ends the run', () => {
        expect(parseTaskTags('#p4 water').text).toBe('#p4 water')
        expect(parseTaskTags('#d-tomorrow water').due).toBeNull()
        // Upper-casing `ſ` gives `S`, but `#ſ-` is not a tag a person wrote in lower case.
        expect(parseTaskTags('#\u017f-2026-09-10 water').scheduled).toBeNull()
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
            test: false,
            cancelled: false,
            archived: false,
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

describe('a Free Tag in the leading run', () => {
    it('is passed over, so the known tags after it are still read', () => {
        const tags = parseTaskTags('#bug #P1 #D Fix the gate')
        expect(tags.priority).toBe(1)
        expect(tags.doing).toBe(true)
        expect(tags.text).toBe('#bug Fix the gate')
    })

    it('stays in the text, so rewriting the run never drops it', () => {
        expect(applyTaskTag('- [ ] #bug #P1 Fix the gate', { kind: 'doing' })).toBe('- [ ] #P1 #D #bug Fix the gate')
        expect(applyTaskTag('- [ ] #P1 Fix the gate #bug', { kind: 'doing' })).toBe('- [ ] #P1 #D Fix the gate #bug')
    })

    it('lists the Task Tags as written, the run\'s and then those after it, without the Free Tags', () => {
        expect(taskTagTokens('#bug #P1 #D-2026-11-02 Fix the gate #W')).toEqual(['#P1', '#D-2026-11-02', '#W'])
        expect(taskTagTokens('#bug #p1 #d-2026-11-02 Fix the gate')).toEqual(['#p1', '#d-2026-11-02'])
        expect(taskTagTokens('Fix the `#P1` gate, see https://example.com/#W')).toEqual([])
    })

    it('does not make a hash word that is not a Free Tag part of the run', () => {
        const tags = parseTaskTags('#my_tag #bug Fix the gate')
        // `#my_tag` ended the run, so the Free Tag after it stays where it is written.
        expect(tags.text).toBe('#my_tag #bug Fix the gate')
        expect(taskTagRun('- [ ] #my_tag #P1 Fix the gate')).toBeNull()
    })
})

describe('freeTagsIn', () => {
    it('finds the Free Tags anywhere in the text, in the order written', () => {
        expect(freeTagsIn('Fix the gate #bug #needs-review')).toEqual(['bug', 'needs-review'])
        expect(freeTagsIn('#garden water the #beans-2 today')).toEqual(['garden', 'beans-2'])
    })

    it('ends a tag at punctuation', () => {
        expect(freeTagsIn('Fix the gate #bug. Then #paint, and #oil!')).toEqual(['bug', 'paint', 'oil'])
    })

    it('matches ignoring case, keeping the first spelling', () => {
        expect(freeTagsIn('#Bug in the gate #bug #BUG')).toEqual(['Bug'])
    })

    it('needs a letter, single hyphens between words, and nothing else', () => {
        expect(freeTagsIn('#123 #2026 #my_tag #a/b #-x #x- #x--y #é')).toEqual([])
        expect(freeTagsIn('#v2 #2-step')).toEqual(['v2', '2-step'])
    })

    it('is a whole word, never the end of another one', () => {
        expect(freeTagsIn('a#b see https://example.com/page#part and item#4')).toEqual([])
    })

    it('is never anything a Task Tag could be, whatever its case', () => {
        expect(freeTagsIn('#P1 #p2 #P4 #W #w #D #d #C #c #D-2026-11-02 #S-2026-11-02 #c-2026-11-02 #s-1')).toEqual([])
        expect(freeTagsIn('#Paint #Docs #Shed')).toEqual(['Paint', 'Docs', 'Shed'])
    })

    it('is not read inside code, a wikilink or a link', () => {
        expect(freeTagsIn('Run `make #all` and read [[Garden #notes]], [the #plan](https://example.com) and <https://example.com/#x>')).toEqual([])
        expect(freeTagsIn('![the #shed|400](../assets/shed.webp) #paint')).toEqual(['paint'])
    })
})

describe('withoutFreeTags', () => {
    it('takes the Free Tags out of the text, with the space before each', () => {
        expect(withoutFreeTags('Fix the gate #bug')).toBe('Fix the gate')
        expect(withoutFreeTags('Fix #bug the gate.')).toBe('Fix the gate.')
        expect(withoutFreeTags('Fix the gate #bug.')).toBe('Fix the gate.')
        expect(withoutFreeTags('#bug #paint Fix the gate')).toBe('Fix the gate')
    })

    it('leaves hash words that are not Free Tags', () => {
        expect(withoutFreeTags('Fix item #4 in `#all` #my_tag')).toBe('Fix item #4 in `#all` #my_tag')
    })

    it('is empty for text that is only Free Tags', () => {
        expect(withoutFreeTags('#bug #paint')).toBe('')
    })
})

describe('taskDisplay', () => {
    it('is the words without the tag run or the Free Tags, and the Free Tags as pills', () => {
        expect(taskDisplay('#bug #P1 Fix the gate #needs-oil')).toEqual({ text: 'Fix the gate', freeTags: ['bug', 'needs-oil'] })
    })

    it('shows Free Tags that are all a task says as its text, with no pills', () => {
        expect(taskDisplay('#P1 #bug')).toEqual({ text: '#bug', freeTags: [] })
        expect(taskDisplay('#P1')).toEqual({ text: '#P1', freeTags: [] })
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

    it('covers tags in any case', () => {
        expect(run('- [ ] #p1 #d-2026-07-01 Ship the release')).toBe('#p1 #d-2026-07-01')
    })

    it('covers a Free Tag in the run, and stops at one after prose', () => {
        expect(run('- [ ] #bug #P1 Fix the gate #paint')).toBe('#bug #P1')
        expect(run('- [ ] #bug Fix the gate')).toBe('#bug')
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

    it('reads a lower-case tag as its tag, and writes the run in upper case', () => {
        expect(applyTaskTag('- [ ] #p1 Fix it', { kind: 'priority', value: 1 })).toBe('- [ ] Fix it')
        expect(applyTaskTag('- [ ] #p1 Fix it', { kind: 'priority', value: 2 })).toBe('- [ ] #P2 Fix it')
        expect(applyTaskTag('- [ ] #w #d-2026-09-15 Fix it', { kind: 'priority', value: 2 })).toBe('- [ ] #P2 #W #D-2026-09-15 Fix it')
    })
})

describe('applyStrayTaskTags', () => {
    it('moves a Task Tag written later in the line into the run, as the # helper writes it', () => {
        expect(applyStrayTaskTags('- [ ] water the beans #P1')).toBe('- [ ] #P1 water the beans')
        expect(applyStrayTaskTags('- [ ] water #W the beans')).toBe('- [ ] #W water the beans')
        expect(applyStrayTaskTags('  - [x] water the beans #P2')).toBe('  - [x] #P2 water the beans')
    })

    it('applies each stray tag as the # helper does: a later priority replaces the run’s', () => {
        expect(applyStrayTaskTags('- [ ] #P1 water the beans #P2')).toBe('- [ ] #P2 water the beans')
        expect(applyStrayTaskTags('- [ ] #P3 #W water #D-2026-09-15 the beans')).toBe('- [ ] #P3 #W #D-2026-09-15 water the beans')
        expect(applyStrayTaskTags('- [ ] #D-2026-01-01 water the beans #D-2026-09-15')).toBe('- [ ] #D-2026-09-15 water the beans')
        expect(applyStrayTaskTags('- [ ] water #S-2026-09-10 the beans #C-2026-09-20')).toBe('- [ ] #S-2026-09-10 #C-2026-09-20 water the beans')
    })

    it('sets the status a state tag names, ticking or unticking the checkbox to match, as a Kanban move does', () => {
        expect(applyStrayTaskTags('- [ ] water the beans #C')).toBe('- [x] #C water the beans')
        expect(applyStrayTaskTags('- [ ] water the beans #A')).toBe('- [x] #A water the beans')
        expect(applyStrayTaskTags('- [x] water the beans #A')).toBe('- [x] #A water the beans')
        expect(applyStrayTaskTags('- [x] #C water the beans #A')).toBe('- [x] #A water the beans')
        expect(applyStrayTaskTags('- [x] water the beans #W')).toBe('- [ ] #W water the beans')
        expect(applyStrayTaskTags('  - [x] water the beans #T')).toBe('  - [ ] #T water the beans')
        expect(applyStrayTaskTags('- [ ] water the beans #D')).toBe('- [ ] #D water the beans')
        expect(applyStrayTaskTags('- [ ] #T water the beans #D')).toBe('- [ ] #D water the beans')
    })

    it('lets the last state tag written win, and keeps the priority, dates and Free Tags', () => {
        expect(applyStrayTaskTags('- [ ] water #C the beans #W')).toBe('- [ ] #W water the beans')
        expect(applyStrayTaskTags('- [ ] water #W the beans #C')).toBe('- [x] #C water the beans')
        expect(applyStrayTaskTags('- [ ] #P1 #S-2026-09-10 water #garden the beans #D-2026-09-15 #C')).toBe('- [x] #P1 #C #S-2026-09-10 #D-2026-09-15 water #garden the beans')
        // The status writer writes no completion date, and keeps one the run carries.
        expect(applyStrayTaskTags('- [x] #C-2026-09-20 water the beans #W')).toBe('- [ ] #W #C-2026-09-20 water the beans')
    })

    it('only ever sets: a tag the run already carries is not cleared, and the stray word goes', () => {
        // The helper's row clears a tag the menu shows is set. A typed tag says what the person wants,
        // so a repeat of one the run carries, or of another stray, keeps it set.
        expect(applyStrayTaskTags('- [ ] #W water the beans #W')).toBe('- [ ] #W water the beans')
        expect(applyStrayTaskTags('- [ ] #P1 water the beans #P1')).toBe('- [ ] #P1 water the beans')
        expect(applyStrayTaskTags('- [ ] water #P1 the beans #P1')).toBe('- [ ] #P1 water the beans')
        expect(applyStrayTaskTags('- [ ] #W water #W and #P2')).toBe('- [ ] #P2 #W water and')
    })

    it('applies several stray tags in the order written, and keeps the Free Tags where they are', () => {
        expect(applyStrayTaskTags('- [ ] water #garden the #P2 beans #W')).toBe('- [ ] #P2 #W water #garden the beans')
        expect(applyStrayTaskTags('- [ ] #kitchen water the beans #P1')).toBe('- [ ] #P1 #kitchen water the beans')
    })

    it('leaves a tag in code, a link or a URL, and one that is not its own word', () => {
        expect(applyStrayTaskTags('- [ ] read `#P1` notes')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read [[Garden #P1]] notes')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read [the #P1 notes](https://example.com) now')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read <https://example.com/#P1> now')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read https://example.com/#P1 now')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read #P1, then water')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read item#P1 now')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read #p4 and #P4 now')).toBeNull()
        // Inline maths is not prose either.
        expect(applyStrayTaskTags('- [ ] read $a #P1 b$ now')).toBeNull()
        expect(applyStrayTaskTags('- [ ] read $a #P1 b$ now #P2')).toBe('- [ ] #P2 read $a #P1 b$ now')
        // A dollar sign with no partner is money, and the tag after it is a tag.
        expect(applyStrayTaskTags('- [ ] pay $5 #P1')).toBe('- [ ] #P1 pay $5')
        // The code span stays as written while a stray tag beside it moves.
        expect(applyStrayTaskTags('- [ ] read `#P1` notes #P2')).toBe('- [ ] #P2 read `#P1` notes')
    })

    it('moves a stray tag written in lower case, and writes it in upper case', () => {
        expect(applyStrayTaskTags('- [ ] water the beans #p1')).toBe('- [ ] #P1 water the beans')
        expect(applyStrayTaskTags('- [ ] water the beans #d-2026-09-15')).toBe('- [ ] #D-2026-09-15 water the beans')
        expect(applyStrayTaskTags('- [ ] water the beans #c')).toBe('- [x] #C water the beans')
        expect(applyStrayTaskTags('- [x] water the beans #w')).toBe('- [ ] #W water the beans')
    })

    it('leaves a lower-case tag in the run until a stray tag rewrites the run', () => {
        expect(applyStrayTaskTags('- [ ] #p1 water the beans')).toBeNull()
        expect(applyStrayTaskTags('  - [x] #w #d-2026-09-15 water the beans')).toBeNull()
        expect(applyStrayTaskTags('- [ ] #p3 water the beans #W')).toBe('- [ ] #P3 #W water the beans')
    })

    it('is null for a task with no stray tag, and for a line that is not a task', () => {
        expect(applyStrayTaskTags('- [ ] #P1 #W water the beans')).toBeNull()
        expect(applyStrayTaskTags('- [ ] water the beans')).toBeNull()
        expect(applyStrayTaskTags('- water the beans #P1')).toBeNull()
        expect(applyStrayTaskTags('water the beans #P1')).toBeNull()
    })
})

describe('a Task Tag written after the leading run', () => {
    it('counts where it is written, and leaves the text', () => {
        expect(parseTaskTags('water the beans #P1')).toMatchObject({ priority: 1, text: 'water the beans' })
        expect(parseTaskTags('water #D-2026-09-15 the beans #s-2026-09-10')).toMatchObject({
            due: '2026-09-15',
            scheduled: '2026-09-10',
            text: 'water the beans',
        })
        expect(parseTaskTags('water the beans #w')).toMatchObject({ waiting: true, text: 'water the beans' })
    })

    it('reads as the line tidy on leave would write, so moving the tag changes nothing a list shows', () => {
        for (const line of [
            '- [ ] water the beans #P1',
            '- [ ] #P1 water the beans #P2 #bug',
            '- [ ] #W water the beans #D',
            '- [ ] #kitchen water #D-2026-09-15 the beans #T',
            '- [x] #C water the beans #A #P3',
            '  - [ ] #D-2026-01-01 water `#P1` the beans #D-2026-09-15',
        ]) {
            const tidied = applyStrayTaskTags(line)!
            const { done, ...read } = parseTaskLine(line)!
            const { done: tidiedDone, ...written } = parseTaskLine(tidied)!
            expect(done).toBe(tidiedDone)
            expect(taskStatus(done, read)).toBe(taskStatus(tidiedDone, written))
            expect({ ...read, ...STATES_OFF }).toEqual({ ...written, ...STATES_OFF })
        }
    })

    it('lets the last of a kind written after the run win, where the run\'s first does', () => {
        expect(parseTaskTags('#P1 #P2 water the beans').priority).toBe(1)
        expect(parseTaskTags('#P1 water #P2 the beans #P3').priority).toBe(3)
        expect(parseTaskTags('#D-2026-01-01 water the beans #D-2026-09-15').due).toBe('2026-09-15')
    })

    it('sets a state in place of the others of its kind, as a status is one thing', () => {
        const waitingThenDoing = parseTaskLine('- [ ] #W water the beans #D')!
        expect(taskStatus(waitingThenDoing.done, waitingThenDoing)).toBe('doing')
        const archivedThenCancelled = parseTaskLine('- [x] #A water the beans #C')!
        expect(taskStatus(archivedThenCancelled.done, archivedThenCancelled)).toBe('cancelled')
    })

    it('never changes what the checkbox says: a state the checkbox contradicts counts for nothing', () => {
        // Tidy on leave is a write, and ticks the task; a reader leaves it open.
        const cancelledUnticked = parseTaskLine('- [ ] #D water the beans #C')!
        expect(cancelledUnticked.done).toBe(false)
        expect(taskStatus(cancelledUnticked.done, cancelledUnticked)).toBe('doing')
        const doingTicked = parseTaskLine('- [x] water the beans #D')!
        expect(doingTicked.done).toBe(true)
        expect(taskStatus(doingTicked.done, doingTicked)).toBe('done')
    })

    it('is not a tag in code, a link, a URL or inline maths, or joined to other characters', () => {
        for (const label of [
            'read `#P1` notes',
            'read [[Garden #P1]] notes',
            'read [the #P1 notes](https://example.com) now',
            'read <https://example.com/#P1> now',
            'read https://example.com/#P1 now',
            'read #P1, then water',
            'read item#P1 now',
            'read #p4 and #P4 now',
            'read $a #P1 b$ now',
        ]) {
            expect(parseTaskTags(label)).toMatchObject({ priority: null, text: label })
        }
    })

    it('is read on the task\'s own line only, never on the lines that continue it', () => {
        expect(parseTaskTags('water the beans\nand the #P1 peas')).toMatchObject({ priority: null, text: 'water the beans\nand the #P1 peas' })
    })

    it('is applied as tidy on leave applies it by a write to the task\'s tags, a state the checkbox contradicts included', () => {
        // Moved into the run unapplied, `#C` would sit there counting for nothing, and leaving the
        // line could no longer cancel the task.
        expect(taskLineWith('- [ ] water the beans #C', { priority: 1 })).toBe('- [x] #P1 #C water the beans')
        expect(applyTaskTag('- [ ] water the beans #C', { kind: 'priority', value: 1 })).toBe('- [x] #P1 #C water the beans')
        expect(taskLineWith('- [x] water the beans #D', { priority: 1 })).toBe('- [ ] #P1 #D water the beans')
        // A status that is asked for is the status written.
        expect(taskLineWith('- [ ] water the beans #C', { status: 'doing' })).toBe('- [ ] #D water the beans')
        // And a write that asks for what the line says already leaves it alone.
        expect(taskLineWith('- [ ] water the beans #C', { priority: null })).toBe('- [ ] water the beans #C')
    })

    it('is moved into the run by any write to the task\'s tags', () => {
        expect(taskLineWith('- [ ] water the beans #P1', { status: 'doing' })).toBe('- [ ] #P1 #D water the beans')
        expect(applyTaskTag('- [ ] water the beans #P1', { kind: 'waiting' })).toBe('- [ ] #P1 #W water the beans')
        // A write that changes nothing leaves the line as it is.
        expect(taskLineWith('- [ ] water the beans #P1', { priority: 1 })).toBe('- [ ] water the beans #P1')
    })
})

describe('the Test and Archived states', () => {
    it('reads bare #T as test and bare #A as archived', () => {
        expect(parseTaskLine('- [ ] #P1 #T Check the gate')).toMatchObject({ test: true, archived: false, priority: 1, text: 'Check the gate' })
        expect(parseTaskLine('- [x] #A Water the beans')).toMatchObject({ archived: true, test: false, text: 'Water the beans' })
    })

    it('reads them in lower case too, and never as Free Tags', () => {
        expect(parseTaskLine('- [ ] #t Check')).toMatchObject({ test: true, text: 'Check' })
        expect(parseTaskLine('- [x] #a Check')).toMatchObject({ archived: true, text: 'Check' })
        expect(freeTagsIn('#t #a Check')).toEqual([])
    })

    it('never reads #T or #A as a Free Tag, whatever its case', () => {
        expect(freeTagsIn('Check #T and #A and #garden')).toEqual(['garden'])
    })

    it('sets and clears each state with the # helper, writing it with the other states', () => {
        expect(applyTaskTag('- [ ] Check', { kind: 'test' })).toBe('- [ ] #T Check')
        expect(applyTaskTag('- [ ] #T Check', { kind: 'test' })).toBe('- [ ] Check')
        expect(applyTaskTag('- [x] #P2 Check', { kind: 'archived' })).toBe('- [x] #P2 #A Check')
        expect(applyTaskTag('- [ ] #A #W #P1 Check', { kind: 'test' })).toBe('- [ ] #P1 #W #T #A Check')
    })
})

describe('taskStatus', () => {
    const status = (line: string) => {
        const task = parseTaskLine(line)!
        return taskStatus(task.done, task)
    }

    it('reads an unticked task as Open, Doing, Waiting or Test', () => {
        expect(status('- [ ] Plant')).toBe('open')
        expect(status('- [ ] #D Plant')).toBe('doing')
        expect(status('- [ ] #W Plant')).toBe('waiting')
        expect(status('- [ ] #T Plant')).toBe('test')
    })

    it('lets the state furthest along win on an unticked task: Test, then Waiting, then Doing', () => {
        expect(status('- [ ] #D #W Plant')).toBe('waiting')
        expect(status('- [ ] #D #W #T Plant')).toBe('test')
    })

    it('reads a ticked task as Done, Cancelled or Archived, Archived winning', () => {
        expect(status('- [x] Plant')).toBe('done')
        expect(status('- [x] #C Plant')).toBe('cancelled')
        expect(status('- [x] #A Plant')).toBe('archived')
        expect(status('- [x] #C #A Plant')).toBe('archived')
    })

    it('ignores a state the checkbox contradicts', () => {
        expect(status('- [ ] #A Plant')).toBe('open')
        expect(status('- [ ] #C Plant')).toBe('open')
        expect(status('- [x] #T #W Plant')).toBe('done')
    })
})
