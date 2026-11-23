import { describe, expect, it } from 'vitest'

import { idleLockText } from './idle-lock-text'

describe('when the graph locks by itself', () => {
    it('is said in the words the setting offers', () => {
        expect(idleLockText(60_000)).toBe('Locks after 1 minute without activity.')
        expect(idleLockText(300_000)).toBe('Locks after 5 minutes without activity.')
        expect(idleLockText(3_600_000)).toBe('Locks after 1 hour without activity.')
        expect(idleLockText(7_200_000)).toBe('Locks after 2 hours without activity.')
    })

    it('says so when it never does', () => {
        expect(idleLockText(0)).toBe('Does not lock after a time without activity.')
    })

    it('counts a time under a minute in seconds', () => {
        expect(idleLockText(30_000)).toBe('Locks after 30 seconds without activity.')
    })
})
