import { describe, expect, it } from 'vitest'

import { laneReferenceId, parseLaneReference, type LaneReference } from './lane-reference'

// A [[Lane Reference]]: the address of a lane of a [[Kanban Board]] inside the [[Agent Instruction]]
// a person copies. The Client writes it and the Headless Client reads it, so the two must agree on
// its shape.

describe('the reference to a lane', () => {
    it('is the board address under the etherpk: scheme, the lane in its fragment', () => {
        expect(laneReferenceId({ graph: { where: 'sync', name: 'g-1' }, concept: 'Garden', status: 'doing' })).toBe('etherpk:/graph/sync/g-1/k/Garden#lane=doing')
    })

    it('encodes the concept as a Document URL does, a segment at a time', () => {
        expect(laneReferenceId({ graph: { where: 'sync', name: 'g-1' }, concept: '[[Garden]] Notes', status: 'open' })).toBe('etherpk:/graph/sync/g-1/k/%5B%5BGarden%5D%5D%20Notes#lane=open')
        expect(laneReferenceId({ graph: { where: 'sync', name: 'g-1' }, concept: 'Garden/Beds', status: 'open' })).toBe('etherpk:/graph/sync/g-1/k/Garden/Beds#lane=open')
    })

    it("is the Graph Kanban's own address on the board of every task", () => {
        expect(laneReferenceId({ graph: { where: 'sync', name: 'g-1' }, concept: null, status: 'waiting' })).toBe('etherpk:/graph/sync/g-1/kanban#lane=waiting')
    })
})

describe('reading a lane reference back', () => {
    const cases: LaneReference[] = [
        { graph: { where: 'sync' as const, name: 'g-1' }, concept: 'Garden', status: 'doing' as const },
        { graph: { where: 'sync', name: 'g-1' }, concept: 'Kitchen Garden', status: 'open' as const },
        { graph: { where: 'sync', name: 'g-1' }, concept: '[[Garden]] Notes', status: 'waiting' as const },
        { graph: { where: 'sync', name: 'g-1' }, concept: 'Garden/Beds', status: 'done' as const },
        { graph: { where: 'sync', name: 'g-1' }, concept: null, status: 'cancelled' as const },
    ]

    it.each(cases)('reads the etherpk: reference alone for $concept', (reference) => {
        expect(parseLaneReference(laneReferenceId(reference))).toEqual(reference)
    })

    it('reads nothing from a task reference, a document address or other text', () => {
        expect(parseLaneReference('etherpk:/graph/sync/g-1/d/Garden#task=3-0123456789ab')).toBeNull()
        expect(parseLaneReference('/graph/sync/g-1/d/Garden')).toBeNull()
        expect(parseLaneReference('water the beans')).toBeNull()
    })

    it('names a folder graph by its folder, and reads that back', () => {
        const reference: LaneReference = { graph: { where: 'folder', name: 'Garden Notes' }, concept: 'Beds', status: 'open' }
        expect(laneReferenceId(reference)).toBe('etherpk:/graph/folder/Garden%20Notes/k/Beds#lane=open')
        expect(parseLaneReference(laneReferenceId(reference))).toEqual(reference)
    })

    it('still reads the shape before ADR 0192, which did not say where the graph is kept', () => {
        expect(parseLaneReference('etherpk:/g/g-1/k/Garden#lane=doing')).toEqual({ graph: { where: 'legacy', name: 'g-1' }, concept: 'Garden', status: 'doing' })
        expect(parseLaneReference('etherpk:/g/g-1/kanban#lane=open')).toEqual({ graph: { where: 'legacy', name: 'g-1' }, concept: null, status: 'open' })
    })

    it('reads nothing from a place a graph is never kept', () => {
        expect(parseLaneReference('etherpk:/graph/cloud/g-1/k/Garden#lane=doing')).toBeNull()
    })

    it('reads nothing from a lane that is no task status, or a malformed escape', () => {
        expect(parseLaneReference('etherpk:/graph/sync/g-1/k/Garden#lane=later')).toBeNull()
        expect(parseLaneReference('etherpk:/graph/sync/g-1/k/Gar%E0den#lane=open')).toBeNull()
    })
})
