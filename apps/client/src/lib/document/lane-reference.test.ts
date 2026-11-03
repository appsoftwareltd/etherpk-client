import { describe, expect, it } from 'vitest'

import { formatLaneReference, laneReferenceId, parseLaneReference } from './lane-reference'

// A [[Lane Reference]]: the text a person copies from a lane of a [[Kanban Board]] to hand the
// lane's tasks to an agent. The Client writes it and the Headless Client reads it, so the two must
// agree on its shape: a round trip through the text is the test that matters.

describe('the reference to a lane', () => {
    it('is the board address under the etherpk: scheme, the lane in its fragment', () => {
        expect(laneReferenceId({ graphId: 'g-1', concept: 'Garden', status: 'doing' })).toBe('etherpk:/g/g-1/k/Garden#lane=doing')
    })

    it('encodes the concept as a Document URL does, a segment at a time', () => {
        expect(laneReferenceId({ graphId: 'g-1', concept: '[[Garden]] Notes', status: 'open' })).toBe('etherpk:/g/g-1/k/%5B%5BGarden%5D%5D%20Notes#lane=open')
        expect(laneReferenceId({ graphId: 'g-1', concept: 'Garden/Beds', status: 'open' })).toBe('etherpk:/g/g-1/k/Garden/Beds#lane=open')
    })

    it("is the Graph Kanban's own address on the board of every task", () => {
        expect(laneReferenceId({ graphId: 'g-1', concept: null, status: 'waiting' })).toBe('etherpk:/g/g-1/kanban#lane=waiting')
    })
})

describe('the text a person copies', () => {
    it("names the graph, the board, the lane and how to list the lane's tasks", () => {
        const text = formatLaneReference({ graphId: 'g-1', concept: 'Kitchen Garden', status: 'doing' }, { graphName: 'Home', laneLabel: 'Doing', count: 3 })
        expect(text.split('\n')).toEqual([
            'EtherPK Kanban lane from the graph "Home" (g-1)',
            'Board: Kitchen Garden',
            'Lane: Doing (3 tasks)',
            'Reference: etherpk:/g/g-1/k/Kitchen%20Garden#lane=doing',
            'This is not a web address. Use the EtherPK MCP server connected to "Home": tasks with concept "Kitchen Garden" and statuses ["doing"] lists the lane\'s tasks (or pass this whole text as reference); read_task, set_task and add_task_note work on each task.',
        ])
    })

    it('names the Graph Kanban, which lists by status alone', () => {
        const text = formatLaneReference({ graphId: 'g-1', concept: null, status: 'open' }, { graphName: 'Home', laneLabel: 'Open', count: 1 })
        expect(text.split('\n')).toEqual([
            'EtherPK Kanban lane from the graph "Home" (g-1)',
            'Board: Graph Kanban',
            'Lane: Open (1 task)',
            'Reference: etherpk:/g/g-1/kanban#lane=open',
            'This is not a web address. Use the EtherPK MCP server connected to "Home": tasks with statuses ["open"] lists the lane\'s tasks (or pass this whole text as reference); read_task, set_task and add_task_note work on each task.',
        ])
    })

    it('names the graph by its id alone when it has no name, as a task reference does', () => {
        const lines = formatLaneReference({ graphId: 'g-1', concept: 'Garden', status: 'test' }, { graphName: null, laneLabel: 'Test', count: 0 }).split('\n')
        expect(lines[0]).toBe('EtherPK Kanban lane from the graph g-1')
        expect(lines[2]).toBe('Lane: Test (0 tasks)')
        expect(lines[4]).toMatch(/^This is not a web address\. Use the EtherPK MCP server connected to that graph: /)
    })
})

describe('reading a lane reference back', () => {
    const cases = [
        { graphId: 'g-1', concept: 'Garden', status: 'doing' as const },
        { graphId: 'g-1', concept: 'Kitchen Garden', status: 'open' as const },
        { graphId: 'g-1', concept: '[[Garden]] Notes', status: 'waiting' as const },
        { graphId: 'g-1', concept: 'Garden/Beds', status: 'done' as const },
        { graphId: 'g-1', concept: null, status: 'cancelled' as const },
    ]

    it.each(cases)('reads the whole copied text for $concept', (reference) => {
        const text = formatLaneReference(reference, { graphName: 'Home', laneLabel: 'Lane', count: 2 })
        expect(parseLaneReference(text)).toEqual(reference)
    })

    it.each(cases)('reads the etherpk: reference alone for $concept', (reference) => {
        expect(parseLaneReference(laneReferenceId(reference))).toEqual(reference)
    })

    it('reads nothing from a task reference, a document address or other text', () => {
        expect(parseLaneReference('etherpk:/g/g-1/d/Garden#task=3-0123456789ab')).toBeNull()
        expect(parseLaneReference('/g/g-1/d/Garden')).toBeNull()
        expect(parseLaneReference('water the beans')).toBeNull()
    })

    it('reads nothing from a lane that is no task status, or a malformed escape', () => {
        expect(parseLaneReference('etherpk:/g/g-1/k/Garden#lane=later')).toBeNull()
        expect(parseLaneReference('etherpk:/g/g-1/k/Gar%E0den#lane=open')).toBeNull()
    })
})
