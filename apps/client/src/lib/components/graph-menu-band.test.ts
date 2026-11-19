import { describe, expect, it } from 'vitest'

import { bandCornerClass } from './graph-menu-band'

describe('a row\'s corners in a Graphs menu group', () => {
    it('rounds all four corners of a group of one', () => {
        expect(bandCornerClass(0, 1)).toBe('rounded-lg')
    })

    it('rounds only the outer corners of the first and last row', () => {
        expect(bandCornerClass(0, 3)).toBe('rounded-t-lg')
        expect(bandCornerClass(1, 3)).toBe('rounded-none')
        expect(bandCornerClass(2, 3)).toBe('rounded-b-lg')
    })
})
