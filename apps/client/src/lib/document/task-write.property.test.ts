import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { bulletLabel } from './index-derive'
import { createInMemoryDocumentStore } from './in-memory-store'
import type { TaskChanges, TaskStatus } from './task-tags'
import { toggleIndexedTask } from './task-toggle'
import { locateTask, undoTaskWrite, writeTaskChanges } from './task-write'

/**
 * A task write starts from where the index last saw the task, which can lag the document (ADR
 * 0113). So over any outline: a task is found where it moved to when lines are added above it, a
 * write and its undo give back the document byte for byte (the task's line and every nested task
 * the write brought along), the same write made twice changes nothing the second time, and a tick
 * from the Tasks View changes checkbox characters and nothing else.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

const WORDS = ['water', 'the', 'beans', 'Garden', 'Kitchen', 'fix', 'gate', 'seeds', 'shed', 'plan']
const words = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map((list) => list.join(' '))

/** A task's box and tags as a person leaves them: open, ticked, cancelled, archived, waiting. */
const TASK_STARTS = ['- [ ] ', '- [x] ', '- [ ] #P1 ', '- [x] #C ', '- [x] #A ', '- [ ] #W #D-2026-11-05 ', '- [X] ']

type Kind = 'bullet' | 'task' | 'fence'

/**
 * An outline of tasks and bullets, each nested at most one level below the line above, with a
 * bullet holding fenced code whose task-shaped line is code. Some pages open with frontmatter,
 * which the index's body-relative line numbers do not count.
 */
const page = fc
    .record({
        frontmatter: fc.boolean(),
        items: fc.array(
            fc.record({ step: fc.integer({ min: -2, max: 1 }), kind: fc.constantFrom<Kind>('bullet', 'task', 'task', 'task', 'fence'), start: fc.constantFrom(...TASK_STARTS), words }),
            { minLength: 1, maxLength: 12 },
        ),
    })
    .map(({ frontmatter, items }) => {
        const lines: string[] = []
        let level = 0
        for (const item of items) {
            level = Math.max(0, level + item.step)
            const pad = '  '.repeat(level)
            if (item.kind === 'bullet') lines.push(`${pad}- ${item.words}`)
            else if (item.kind === 'task') lines.push(`${pad}${item.start}${item.words}`)
            else lines.push(`${pad}- Code`, `${pad}  \`\`\``, `${pad}  - [ ] not a task`, `${pad}  \`\`\``)
        }
        return { head: frontmatter ? ['---', 'title: Garden', '---'] : [], body: lines }
    })

/** The body lines that hold a task, as the index reads them (outside fenced code). */
function taskLines(body: readonly string[]): number[] {
    let inFence = false
    const out: number[] = []
    body.forEach((line, i) => {
        if (line.trim().startsWith('```')) inFence = !inFence
        else if (!inFence && /^\s*-\s+\[[ xX]\]/.test(line)) out.push(i)
    })
    return out
}

const STATUSES: TaskStatus[] = ['open', 'doing', 'waiting', 'test', 'done', 'cancelled', 'archived']

const changes: fc.Arbitrary<TaskChanges> = fc.record(
    {
        status: fc.constantFrom(...STATUSES),
        priority: fc.constantFrom(null, 1, 2, 3) as fc.Arbitrary<TaskChanges['priority']>,
        due: fc.constantFrom(null, '2026-11-09'),
        scheduled: fc.constantFrom(null, '2026-11-05'),
    },
    { requiredKeys: [] },
)

describe('finding a task the index may have lost track of', () => {
    it('finds a task whose text is its own where it moved when lines were added above it, whatever its tags now', () => {
        fc.assert(
            fc.property(page, fc.nat(), fc.array(fc.tuple(fc.nat(), fc.constantFrom('- a bullet', 'Some prose', '- [ ] another task')), { minLength: 1, maxLength: 4 }), (doc, pick, inserts) => {
                const tasks = taskLines(doc.body)
                fc.pre(tasks.length > 0)
                const index = tasks[pick % tasks.length]
                const label = bulletLabel(doc.body[index])
                // Give the task a text no other line has, so it can be told apart.
                const lines = [...doc.body]
                lines[index] = `${lines[index]} unique`
                const indexed = `${label} unique`.replace(/^#\S+\s*/, '#P2 ')
                let at = index
                for (const [where, line] of inserts) {
                    const pos = where % (at + 1)
                    lines.splice(pos, 0, line)
                    at++
                }
                expect(locateTask(lines, index, indexed)).toBe(at)
            }),
            fuzz(500),
        )
    })
})

describe('a task write and its undo', () => {
    it('gives back the document byte for byte, and a second write of the same changes changes nothing', async () => {
        await fc.assert(
            fc.asyncProperty(page, fc.nat(), changes, async (doc, pick, change) => {
                const tasks = taskLines(doc.body)
                fc.pre(tasks.length > 0)
                const line = tasks[pick % tasks.length]
                const text = [...doc.head, ...doc.body].join('\n')
                const store = createInMemoryDocumentStore({ Garden: text })
                const task = { concept: 'Garden', line, text: bulletLabel(doc.body[line]) }

                const write = await writeTaskChanges(store, task, change)
                if (!write.ok) throw new Error(`the write was refused: ${write.reason}`)
                const written = store.open('Garden').getText()
                const again = await writeTaskChanges(store, { ...task, text: write.text }, change)
                expect(again).toMatchObject({ ok: true, changed: false })
                expect(store.open('Garden').getText()).toBe(written)

                const undo = await undoTaskWrite(store, 'Garden', write)
                expect(undo).toMatchObject({ ok: true, skipped: 0 })
                expect(store.open('Garden').getText()).toBe(text)
            }),
            fuzz(300),
        )
    })

    it('ticks from the Tasks View by changing checkbox characters only, and its undo gives the document back', async () => {
        await fc.assert(
            fc.asyncProperty(page, fc.nat(), fc.boolean(), async (doc, pick, done) => {
                const tasks = taskLines(doc.body)
                fc.pre(tasks.length > 0)
                const line = tasks[pick % tasks.length]
                const text = [...doc.head, ...doc.body].join('\n')
                const store = createInMemoryDocumentStore({ Garden: text })

                const tick = await toggleIndexedTask(store, { concept: 'Garden', line, text: bulletLabel(doc.body[line]) }, done)
                if (!tick.ok) throw new Error(`the tick was refused: ${tick.reason}`)
                const ticked = store.open('Garden').getText()
                expect(ticked.length).toBe(text.length)
                for (let i = 0; i < text.length; i++) {
                    if (ticked[i] !== text[i]) expect(`${text[i]}${ticked[i]}`).toMatch(/^[ xX][ xX]$/)
                }
                if (tick.write === null) {
                    expect(ticked).toBe(text)
                    return
                }
                await undoTaskWrite(store, 'Garden', tick.write)
                expect(store.open('Garden').getText()).toBe(text)
            }),
            fuzz(300),
        )
    })
})
