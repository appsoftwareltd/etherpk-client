import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
    applyStrayTaskTags,
    applyTaskTag,
    freeTagsIn,
    parseTaskLine,
    parseTaskTags,
    serialiseTags,
    type TaskStatus,
    type TaskTagCommand,
    type TaskTags,
    taskLineWith,
    taskStatus,
    taskTagTokens,
    toggleTaskLine,
    withoutFreeTags,
} from './task-tags'

/**
 * A task's metadata is the run of Task Tags right after its checkbox (ADR 0032), and every writer
 * rewrites that run in one fixed order. These properties hold the grammar to that over any task
 * line: what the run writes reads back as the same tags in any case, issuing a toggle twice puts
 * the run back, a status write reads back as that status, a tick touches the checkbox alone, a
 * stray tag moved into the run is moved once, and taking Free Tags out of a text keeps its words.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

const WORDS = ['water', 'the', 'beans', 'Garden', 'Kitchen', 'fix', 'gate', 'seeds', 'shed', 'plan']
const FREE_TAGS = ['#bug', '#garden', '#needs-oil', '#Kitchen2']
/** Hash words in prose that are neither Task Tags nor Free Tags, so they end a run. */
const HASH_PROSE = ['#P4', '#1', 'item#2', '#my_tag', '`#P1`', 'https://example.com/#W']

/** `YYYY-MM-DD`, shape only: the grammar does not check the calendar. */
const date = fc
    .tuple(fc.integer({ min: 2000, max: 2099 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 31 }))
    .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)

const tags: fc.Arbitrary<Omit<TaskTags, 'text'>> = fc.record({
    priority: fc.constantFrom(null, 1, 2, 3) as fc.Arbitrary<TaskTags['priority']>,
    waiting: fc.boolean(),
    doing: fc.boolean(),
    test: fc.boolean(),
    cancelled: fc.boolean(),
    archived: fc.boolean(),
    due: fc.option(date, { nil: null }),
    completion: fc.option(date, { nil: null }),
    scheduled: fc.option(date, { nil: null }),
})

/** A task's words: prose, Free Tags and hash words, single spaced, never starting with a Task Tag. */
const text = fc.array(fc.constantFrom(...WORDS, ...WORDS, ...FREE_TAGS, ...HASH_PROSE), { maxLength: 6 }).map((words) => words.join(' '))

/** A Task Tag as a person might type it, in either case. */
const TAG_TOKENS = ['#P1', '#p2', '#P3', '#W', '#d', '#T', '#c', '#A', '#D-2026-11-05', '#s-2026-01-31', '#C-2026-02-03']

/** A raw task line: any indent, any checkbox, a tag run of any tokens, then words and stray tags. */
const taskLine = fc
    .record({
        indent: fc.constantFrom('', '  ', '    '),
        box: fc.constantFrom(' ', 'x', 'X'),
        run: fc.array(fc.constantFrom(...TAG_TOKENS, ...FREE_TAGS), { maxLength: 4 }),
        words: fc.array(fc.constantFrom(...WORDS, ...FREE_TAGS, ...HASH_PROSE, ...TAG_TOKENS), { maxLength: 6 }),
    })
    .map(({ indent, box, run, words }) => [`${indent}- [${box}]`, ...run, ...words].join(' '))

const toggleCommand: fc.Arbitrary<TaskTagCommand> = fc.oneof(
    fc.constantFrom(1, 2, 3).map((value) => ({ kind: 'priority', value }) as TaskTagCommand),
    fc.constantFrom('waiting', 'doing', 'test', 'cancelled', 'archived').map((kind) => ({ kind }) as TaskTagCommand),
)

const dateCommand: fc.Arbitrary<TaskTagCommand> = fc
    .tuple(fc.constantFrom('due', 'scheduled', 'completion'), date)
    .map(([kind, value]) => ({ kind, value }) as TaskTagCommand)

const STATUSES: TaskStatus[] = ['open', 'doing', 'waiting', 'test', 'done', 'cancelled', 'archived']

/** Whether a whitespace-separated token is a Task Tag the grammar reads. */
const isTaskTag = (token: string) => taskTagTokens(token).length === 1

describe('the task tag run reads back what it writes', () => {
    it('parses the run serialiseTags writes as the same tags and text, in upper or lower case', () => {
        fc.assert(
            fc.property(tags, text, fc.boolean(), (set, words, lower) => {
                const run = serialiseTags({ ...set, text: '' }).map((token) => (lower ? token.toLowerCase() : token))
                const label = [...run, words].filter((part) => part !== '').join(' ')
                expect(parseTaskTags(label)).toEqual({ ...set, text: words })
            }),
            fuzz(500),
        )
    })

    it('puts the line back when the same toggle is issued twice, and a date is set once whatever its repeats', () => {
        fc.assert(
            fc.property(taskLine, toggleCommand, dateCommand, (line, toggle, dated) => {
                // The first write puts the run in its fixed order; from there a toggle is its own inverse.
                const once = applyTaskTag(line, toggle)!
                expect(applyTaskTag(applyTaskTag(once, toggle)!, toggle)).toBe(once)
                const withDate = applyTaskTag(line, dated)!
                expect(applyTaskTag(withDate, dated)).toBe(withDate)
                expect(parseTaskLine(withDate)?.[dated.kind as 'due' | 'scheduled' | 'completion']).toBe((dated as { value: string }).value)
            }),
            fuzz(500),
        )
    })

    it('reads a written status back as that status, keeping the words, and writes it only once', () => {
        fc.assert(
            fc.property(taskLine, fc.constantFrom(...STATUSES), fc.option(fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>, { nil: null }), (line, status, priority) => {
                const before = parseTaskLine(line)!
                const written = taskLineWith(line, { status, priority })!
                const after = parseTaskLine(written)!
                expect(taskStatus(after.done, after)).toBe(status)
                expect(after.priority).toBe(priority)
                expect(after.text).toBe(before.text)
                expect([after.due, after.scheduled, after.completion]).toEqual([before.due, before.scheduled, before.completion])
                expect(taskLineWith(written, { status, priority })).toBe(written)
            }),
            fuzz(500),
        )
    })
})

describe('a tick changes the checkbox and nothing else', () => {
    it('changes one character, reads back ticked or not as asked, and ticks back to the line it was', () => {
        fc.assert(
            fc.property(taskLine, fc.boolean(), (line, done) => {
                const toggled = toggleTaskLine(line, done)!
                expect(toggled.length).toBe(line.length)
                expect([...toggled].filter((char, i) => char !== line[i]).length).toBeLessThanOrEqual(1)
                const { done: was, ...rest } = parseTaskLine(line)!
                expect(parseTaskLine(toggled)).toEqual({ ...rest, done })
                // `X` is read as ticked but written as `x`, so only a line in the written spelling comes back exactly.
                const restored = toggleTaskLine(toggled, was)!
                if (!line.includes('[X]')) expect(restored).toBe(line)
            }),
            fuzz(500),
        )
    })
})

describe('stray Task Tags and Free Tags', () => {
    it('moves every stray tag into the run in one pass, keeping the prose words and the Free Tags', () => {
        fc.assert(
            fc.property(taskLine, (line) => {
                const tidied = applyStrayTaskTags(line) ?? line
                // A second pass finds nothing left to move.
                expect(applyStrayTaskTags(tidied)).toBeNull()
                const prose = (task: string) =>
                    parseTaskLine(task)!
                        .text.split(/\s+/)
                        .filter((token) => token !== '' && !isTaskTag(token))
                expect(prose(tidied)).toEqual(prose(line))
                expect(freeTagsIn(parseTaskLine(tidied)!.text)).toEqual(freeTagsIn(parseTaskLine(line)!.text))
            }),
            fuzz(500),
        )
    })

    it('takes out every Free Tag and keeps every other character in order', () => {
        const token = fc.oneof(
            fc.constantFrom(...WORDS, ...HASH_PROSE),
            fc.tuple(fc.constantFrom(...FREE_TAGS), fc.constantFrom('', '.', ',', '!', ')')).map(([tag, mark]) => tag + mark),
        )
        fc.assert(
            fc.property(fc.array(token, { maxLength: 8 }), (tokens) => {
                const words = tokens.join(' ')
                const kept = withoutFreeTags(words)
                expect(freeTagsIn(kept)).toEqual([])
                const expected = tokens.map((t) => (FREE_TAGS.some((tag) => t.startsWith(tag)) ? t.replace(/^#[\w-]+/, '') : t)).join('')
                expect(kept.replace(/\s/g, '')).toBe(expected)
            }),
            fuzz(500),
        )
    })
})
