import { afterEach, describe, expect, it } from 'vitest'

import { pendingBookmarkReveal, requestBookmarkReveal, resetBookmarkStatus, REVEAL_WAIT_MS, takeBookmarkReveal } from './status'

afterEach(() => resetBookmarkStatus())

describe('a request to show a bookmark', () => {
    it('is taken once, by the bookmark it names', () => {
        requestBookmarkReveal('a', 'Garden', 0)
        expect(takeBookmarkReveal('b', 0)).toBe(false)
        expect(takeBookmarkReveal('a', 0)).toBe(true)
        expect(takeBookmarkReveal('a', 0)).toBe(false)
    })

    it('lapses, so a line that comes back much later does not move the caret', () => {
        requestBookmarkReveal('a', 'Garden', 0)
        expect(pendingBookmarkReveal(REVEAL_WAIT_MS)).toEqual({ id: 'a', concept: 'Garden' })
        expect(takeBookmarkReveal('a', REVEAL_WAIT_MS + 1)).toBe(false)
        expect(pendingBookmarkReveal(REVEAL_WAIT_MS + 1)).toBeNull()
    })
})
