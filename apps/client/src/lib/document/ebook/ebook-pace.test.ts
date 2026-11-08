import { describe, expect, it } from 'vitest'

import { countsAsReading, formatMinutes, NEW_PACE, paceAfterTurn, paceMinutes, sanitizePace } from './ebook-pace'

describe('a person\'s reading pace', () => {
    it('leaves the estimate alone until it has seen a few turns', () => {
        const pace = paceAfterTurn(NEW_PACE, 1, 2)
        expect(paceMinutes(pace, 10)).toBe(10)
    })

    it('learns that a person reads at half the estimate\'s speed', () => {
        let pace = NEW_PACE
        for (let i = 0; i < 20; i++) pace = paceAfterTurn(pace, 1, 2)
        expect(paceMinutes(pace, 10)).toBeCloseTo(20)
    })

    it('ignores what is not reading: a jump, a skim, and a walk away', () => {
        expect(paceAfterTurn(NEW_PACE, 30, 2)).toBe(NEW_PACE)
        expect(paceAfterTurn(NEW_PACE, 1, 0.01)).toBe(NEW_PACE)
        expect(paceAfterTurn(NEW_PACE, 1, 40)).toBe(NEW_PACE)
        expect(paceAfterTurn(NEW_PACE, -1, 1)).toBe(NEW_PACE)
    })

    it('holds a very fast or slow turn to a limit, so one cannot swing it', () => {
        expect(paceAfterTurn(NEW_PACE, 0.1, 4).factor).toBe(5)
    })

    it('counts time between turns as reading only when the person seems to be there', () => {
        expect(countsAsReading(1)).toBe(true)
        expect(countsAsReading(30)).toBe(false)
    })

    it('reads a stored pace with care', () => {
        expect(sanitizePace({ factor: 99, samples: 3 })).toBe(NEW_PACE)
        expect(sanitizePace('x')).toBe(NEW_PACE)
        expect(sanitizePace({ factor: 2, samples: 3 })).toEqual({ factor: 2, samples: 3 })
    })

    it('says minutes as a person reads them', () => {
        expect(formatMinutes(0.2)).toBe('under a minute')
        expect(formatMinutes(12)).toBe('12 min')
        expect(formatMinutes(125)).toBe('2 h 5 min')
        expect(formatMinutes(120)).toBe('2 h')
    })
})
