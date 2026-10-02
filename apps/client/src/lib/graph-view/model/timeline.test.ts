import { describe, expect, it } from 'vitest'

import { linkGraphOf } from './link-graph-fixture'
import { timelineOf } from './timeline'

describe('timelineOf', () => {
    const timeline = timelineOf(
        linkGraphOf({
            journals: ['2026-09-01', '2026-09-03', '2026-02-30'],
            pages: ['Garden', 'Reading List'],
            links: [
                ['2026-09-03', 'Garden'],
                ['2026-09-01', 'Garden'],
                ['2026-09-03', 'Compost'],
                ['Garden', 'Soil'],
                ['Reading List', 'Garden'],
                ['2026-02-30', 'Mulch'],
            ],
        }),
    )

    it('puts a journal entry on its own day', () => {
        expect(timeline.conceptDay('2026-09-01')).toBe('2026-09-01')
        expect(timeline.conceptDay('2026-09-03')).toBe('2026-09-03')
    })

    it('puts any other concept on the first day a journal entry links to it', () => {
        expect(timeline.conceptDay('garden')).toBe('2026-09-01')
        expect(timeline.conceptDay('compost')).toBe('2026-09-03')
    })

    it('has a concept no journal entry mentions present from the start', () => {
        expect(timeline.conceptDay('soil')).toBeNull()
        expect(timeline.conceptDay('reading list')).toBeNull()
    })

    it('ignores a journal entry whose name is not a real day', () => {
        expect(timeline.conceptDay('2026-02-30')).toBeNull()
        expect(timeline.conceptDay('mulch')).toBeNull()
    })

    it('draws a line from the day its later end appears', () => {
        expect(timeline.lineDay('2026-09-03', 'garden')).toBe('2026-09-03')
        expect(timeline.lineDay('garden', 'soil')).toBe('2026-09-01')
        expect(timeline.lineDay('reading list', 'soil')).toBeNull()
    })

    it('lists the days on which something appears, in order', () => {
        expect(timeline.days).toEqual(['2026-09-01', '2026-09-03'])
    })
})
