import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type NewTask, asCommentBullet, commentChange, emptyCommentsRemoval, newTaskLines, readTaskStructure, taskComments, taskLineWithFreeTag, taskRemoval } from './task-structure'
import type { TaskStatus } from './task-tags'

/**
 * The Task Editor reads a task as a structure over its lines and writes it back as text (ADR 0170),
 * and the markdown stays the truth. So over any outline: a new task's lines read back as the fields
 * they were written from, every line nested under a task is in exactly one part of the structure, a
 * comment lands as the last comment and moves nothing else, removing a task removes its branch and
 * nothing else, and a Free Tag added and taken out leaves the title as it was.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

const WORDS = ['water', 'the', 'beans', 'Garden', 'Kitchen', 'fix', 'gate', 'seeds', 'shed', 'plan']
const words = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 }).map((list) => list.join(' '))

type Kind = 'bullet' | 'task' | 'done' | 'comments' | 'fence' | 'heading'

/**
 * An outline as the editor writes one: each line nested at most one level below the line above,
 * with tasks, Comments bullets, a bullet with fenced code under it (whose task-shaped line is code),
 * and headings at the margin.
 */
const outline = fc
    .array(
        fc.record({
            step: fc.integer({ min: -3, max: 1 }),
            kind: fc.constantFrom<Kind>('bullet', 'task', 'task', 'done', 'comments', 'fence', 'heading'),
            words,
        }),
        { minLength: 1, maxLength: 14 },
    )
    .map((items) => {
        const lines: string[] = []
        let level = 0
        for (const item of items) {
            level = item.kind === 'heading' ? 0 : Math.max(0, level + item.step)
            const pad = '  '.repeat(level)
            if (item.kind === 'heading') lines.push(`## ${item.words}`)
            else if (item.kind === 'bullet') lines.push(`${pad}- ${item.words}`)
            else if (item.kind === 'task') lines.push(`${pad}- [ ] ${item.words}`)
            else if (item.kind === 'done') lines.push(`${pad}- [x] ${item.words}`)
            else if (item.kind === 'comments') lines.push(`${pad}- Comments`)
            else lines.push(`${pad}- Code`, `${pad}  \`\`\``, `${pad}  - [ ] not a task`, `${pad}  \`\`\``)
        }
        return lines
    })

/** The task lines of an outline, as `readTaskStructure` finds them. */
function tasksIn(lines: readonly string[]): number[] {
    return lines.map((_, i) => i).filter((i) => readTaskStructure(lines, i) !== null)
}

const STATUSES: TaskStatus[] = ['open', 'doing', 'waiting', 'test', 'done', 'cancelled', 'archived']

const newTask: fc.Arbitrary<NewTask> = fc.record({
    status: fc.constantFrom(...STATUSES),
    priority: fc.constantFrom(null, 1, 2, 3) as fc.Arbitrary<NewTask['priority']>,
    title: fc.oneof(fc.constant(''), words),
    freeTags: fc.uniqueArray(fc.constantFrom('bug', 'Bug', 'needs-oil', 'garden2'), { maxLength: 3, selector: (tag) => tag.toLowerCase() }),
    // A date that is no whole `YYYY-MM-DD` is written as none.
    due: fc.constantFrom(null, '2026-11-09', '2026-02-30', '2026-11', 'soon'),
    scheduled: fc.constantFrom(null, '2026-11-05', ''),
})

/** A description as a person types one: bullets, nested bullets and blank lines, at the left margin. */
const description = fc.array(fc.tuple(fc.constantFrom('- ', '  - ', '- [ ] ', ''), words), { maxLength: 4 }).map((rows) => rows.map(([marker, text]) => (marker === '' ? '' : marker + text)).join('\n'))

const isDate = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)

describe('a task’s structure reads back what the Task Editor writes', () => {
    it('reads a new task’s lines back as its status, priority, title, Free Tags and dates', () => {
        fc.assert(
            fc.property(newTask, description, (task, body) => {
                const lines = newTaskLines(task, body)
                const read = readTaskStructure(lines, 0)!
                expect(read).toMatchObject({
                    status: task.status,
                    priority: task.priority,
                    title: task.title,
                    freeTags: task.freeTags,
                    due: isDate(task.due),
                    scheduled: isDate(task.scheduled),
                })
                // Everything written under it is its description, and nothing else.
                expect(read.description).toEqual({ from: 1, to: lines.length })
                expect(read.end).toBe(lines.length)
            }),
            fuzz(500),
        )
    })

    it('puts every line nested under a task in exactly one part, in order', () => {
        fc.assert(
            fc.property(outline, (lines) => {
                for (const index of tasksIn(lines)) {
                    const task = readTaskStructure(lines, index)!
                    const parts: [number, number][] = [[task.description.from, task.description.to]]
                    if (task.commentsLine !== null) parts.push([task.commentsLine, task.commentsLine + 1])
                    if (task.comments) parts.push([task.comments.from, task.comments.to])
                    if (task.additionalContext) parts.push([task.additionalContext.from, task.additionalContext.to])
                    // Each part starts where the one before ends, from the line after the task to its end.
                    let at = index + 1
                    for (const [from, to] of parts) {
                        expect(from).toBe(at)
                        expect(to).toBeGreaterThanOrEqual(from)
                        at = to
                    }
                    expect(at).toBe(task.end)
                }
            }),
            fuzz(500),
        )
    })
})

describe('writing into a task’s lines', () => {
    it('adds a comment as the task’s last comment, leaving its other lines and the rest of the outline as they were', () => {
        const note = fc.array(words, { minLength: 1, maxLength: 2 }).map((rows) => rows.join('\n'))
        fc.assert(
            fc.property(outline, fc.nat(), note, (lines, pick, text) => {
                const tasks = tasksIn(lines)
                fc.pre(tasks.length > 0)
                const index = tasks[pick % tasks.length]
                const before = readTaskStructure(lines, index)!
                const doc = lines.join('\n')
                const change = commentChange(doc, index, asCommentBullet(text))!
                const after = (doc.slice(0, change.from) + change.insert + doc.slice(change.to)).split('\n')
                const read = readTaskStructure(after, index)!

                // A note's later lines continue its bullet, so they read back indented under it: the
                // same markdown, compared by its words.
                const comments = taskComments(after, read)
                expect(comments.slice(0, -1)).toEqual(taskComments(lines, before))
                expect(comments.at(-1)!.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
                expect(after.slice(read.description.from, read.description.to)).toEqual(lines.slice(before.description.from, before.description.to))
                // Only lines are added, all of them inside the task's branch.
                const added = after.length - lines.length
                expect(after.slice(0, index + 1)).toEqual(lines.slice(0, index + 1))
                expect(after.slice(before.end + added)).toEqual(lines.slice(before.end))
                expect(read.end).toBe(before.end + added)
                expect(after[change.line]).toContain(text.split('\n')[0])
            }),
            fuzz(500),
        )
    })

    it('takes out an empty comment Add a comment started, leaving the outline as it was', () => {
        fc.assert(
            fc.property(outline, fc.nat(), (lines, pick) => {
                const tasks = tasksIn(lines).filter((index) => readTaskStructure(lines, index)!.comments === null)
                fc.pre(tasks.length > 0)
                const index = tasks[pick % tasks.length]
                const doc = lines.join('\n')
                const started = commentChange(doc, index, asCommentBullet(''))!
                const withEmpty = doc.slice(0, started.from) + started.insert + doc.slice(started.to)
                const removal = emptyCommentsRemoval(withEmpty, index)!
                expect(withEmpty.slice(0, removal.from) + removal.insert + withEmpty.slice(removal.to)).toBe(doc)
            }),
            fuzz(300),
        )
    })

    it('never takes out a Comments block that holds a comment with words', () => {
        fc.assert(
            fc.property(outline, fc.nat(), words, (lines, pick, text) => {
                const tasks = tasksIn(lines)
                fc.pre(tasks.length > 0)
                const index = tasks[pick % tasks.length]
                const doc = lines.join('\n')
                const change = commentChange(doc, index, asCommentBullet(text))!
                expect(emptyCommentsRemoval(doc.slice(0, change.from) + change.insert + doc.slice(change.to), index)).toBeNull()
            }),
            fuzz(300),
        )
    })

    it('removes a task with exactly the lines nested under it', () => {
        fc.assert(
            fc.property(outline, fc.nat(), (lines, pick) => {
                const tasks = tasksIn(lines)
                fc.pre(tasks.length > 0)
                const index = tasks[pick % tasks.length]
                const { end } = readTaskStructure(lines, index)!
                const doc = lines.join('\n')
                const removal = taskRemoval(doc, index)!
                expect(doc.slice(0, removal.from) + doc.slice(removal.to)).toBe([...lines.slice(0, index), ...lines.slice(end)].join('\n'))
                expect(doc.slice(0, removal.from) + removal.removed + doc.slice(removal.to)).toBe(doc)
            }),
            fuzz(500),
        )
    })

    it('adds a Free Tag and takes it out again without changing the title or the other tags', () => {
        const line = fc
            .tuple(fc.constantFrom('- [ ] ', '  - [x] #P1 ', '- [ ] #W #bug '), words, fc.constantFrom('', ' #oil', ' #Kitchen2'))
            .map(([start, text, end]) => start + text + end)
        fc.assert(
            fc.property(line, fc.constantFrom('needs-oil', 'Bug', 'garden2', 'oil'), (task, tag) => {
                const before = readTaskStructure([task], 0)!
                const added = taskLineWithFreeTag(task, tag, true)!
                const readAdded = readTaskStructure([added], 0)!
                expect(readAdded.freeTags.map((t) => t.toLowerCase())).toContain(tag.toLowerCase())
                expect(readAdded.title).toBe(before.title)

                const removed = taskLineWithFreeTag(added, tag, false)!
                const readRemoved = readTaskStructure([removed], 0)!
                expect(readRemoved.freeTags).toEqual(before.freeTags.filter((t) => t.toLowerCase() !== tag.toLowerCase()))
                expect(readRemoved).toMatchObject({ title: before.title, status: before.status, priority: before.priority })
            }),
            fuzz(500),
        )
    })
})
