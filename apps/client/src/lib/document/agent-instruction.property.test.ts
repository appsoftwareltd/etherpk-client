import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type AgentReach, formatLaneInstruction, formatTaskInstruction } from './agent-instruction'
import type { TaskStatus } from './index-db'
import { parseLaneReference, type LaneReference } from './lane-reference'
import { parseTaskReference, type TaskReference } from './task-reference'

/**
 * An Agent Instruction is pasted into an agent's chat, and many of those show the paste as
 * markdown, joining lines that have no blank line between them into one paragraph. So whatever the
 * task's words, the graph or the lane, each part of the instruction is one line with a blank line
 * on either side, and the reference still reads back from the whole text.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261120 : Number(seed) }
}

/** Task words with the whitespace a pasted or wrapped label can carry, line breaks included. */
const label = fc.stringMatching(/^(?:#P[123] |#[WDT] )*[a-z #.,\t\r\n\u2028]{0,40}$/)

/** A name as a graph or folder shows it: one line, never empty. */
const name = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,15}$/)

const reach: fc.Arbitrary<AgentReach> = fc.oneof(
    fc.record({ kind: fc.constant('synced' as const), graphName: fc.option(name, { nil: null }), agentsUrl: fc.constant('https://app.example.com/graph/sync/g-1?settings=agents') }),
    fc.record({ kind: fc.constant('browser' as const), graphName: fc.option(name, { nil: null }), agentsUrl: fc.constant('https://app.example.com/graph/browser/g-1?settings=agents') }),
    fc.record({
        kind: fc.constant('folder' as const),
        folderName: name,
        folderPath: fc.option(fc.constantFrom('/path/to/notes', 'C:\\notes'), { nil: null }),
        file: fc.option(fc.record({ subdir: fc.constantFrom('pages' as const, 'journals' as const), fileName: fc.constantFrom('Garden.md', 'Kitchen Garden.md') }), { nil: null }),
    }),
)

const STATUSES: TaskStatus[] = ['open', 'doing', 'waiting', 'test', 'done', 'cancelled', 'archived']

const taskReference: fc.Arbitrary<TaskReference> = fc.record({
    graph: fc.constant({ where: 'sync' as const, name: 'g-1' }),
    document: fc.constantFrom('Garden', 'Kitchen Garden', '2026-11-20'),
    line: fc.nat({ max: 500 }),
    fingerprint: fc.stringMatching(/^[0-9a-f]{12}$/),
})

const laneReference: fc.Arbitrary<LaneReference> = fc.record({
    graph: fc.constant({ where: 'sync' as const, name: 'g-1' }),
    concept: fc.option(fc.constantFrom('Garden', 'Kitchen Garden'), { nil: null }),
    status: fc.constantFrom(...STATUSES),
})

/** Every part one line, each set apart by exactly one blank line, nothing before or after. */
function expectParagraphs(text: string): void {
    const parts = text.split('\n\n')
    expect(parts.length).toBeGreaterThan(2)
    for (const part of parts) {
        expect(part).not.toBe('')
        expect(part).not.toMatch(/[\n\r\u2028]/)
    }
}

describe('an agent instruction, whatever it names', () => {
    it("sets each part of a task's instruction apart, and reads back", () => {
        fc.assert(
            fc.property(taskReference, label, reach, (reference, words, where) => {
                const copied = formatTaskInstruction(reference, words, where)
                expectParagraphs(copied)
                if (where.kind !== 'browser') expect(parseTaskReference(copied)).toEqual(reference)
            }),
            fuzz(300),
        )
    })

    it("sets each part of a lane's instruction apart, and reads back", () => {
        fc.assert(
            fc.property(laneReference, fc.constantFrom('Open', 'Doing', 'Test'), fc.nat({ max: 99 }), reach, (reference, laneLabel, count, where) => {
                const copied = formatLaneInstruction(reference, { laneLabel, count }, where)
                expectParagraphs(copied)
                if (where.kind !== 'browser') expect(parseLaneReference(copied)).toEqual(reference)
            }),
            fuzz(300),
        )
    })
})
