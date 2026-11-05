import { describe, expect, it } from 'vitest'

import { laneReferenceId, parseLaneReference } from './lane-reference'

// A [[Lane Reference]]: the address of a lane of a [[Kanban Board]] inside the [[Agent Instruction]]
// a person copies. The Client writes it and the Headless Client reads it, so the two must agree on
// its shape.

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

describe('reading a lane reference back', () => {
    const cases = [
        { graphId: 'g-1', concept: 'Garden', status: 'doing' as const },
        { graphId: 'g-1', concept: 'Kitchen Garden', status: 'open' as const },
        { graphId: 'g-1', concept: '[[Garden]] Notes', status: 'waiting' as const },
        { graphId: 'g-1', concept: 'Garden/Beds', status: 'done' as const },
        { graphId: 'g-1', concept: null, status: 'cancelled' as const },
    ]

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
