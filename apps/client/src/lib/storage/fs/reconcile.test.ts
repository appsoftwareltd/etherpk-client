import { describe, expect, it } from 'vitest'

import { reconcileDecision } from './reconcile'

describe('reconcileDecision', () => {
    it('is a no-op when disk matches our last-synced text (incl. our own write)', () => {
        expect(reconcileDecision({ dirty: false, baseText: 'x', diskText: 'x' })).toBe('noop')
        expect(reconcileDecision({ dirty: true, baseText: 'x', diskText: 'x' })).toBe('noop')
    })

    it('reloads when the disk changed under a clean buffer', () => {
        expect(reconcileDecision({ dirty: false, baseText: 'old', diskText: 'new' })).toBe('reload')
    })

    it('conflicts when the disk changed under a dirty buffer', () => {
        expect(reconcileDecision({ dirty: true, baseText: 'old', diskText: 'new' })).toBe('conflict')
    })
})
