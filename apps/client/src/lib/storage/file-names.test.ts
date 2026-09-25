import { describe, expect, it } from 'vitest'

import { portableFileName, suffixedFileName } from './file-names'

describe('portableFileName', () => {
    it('is the portable stem plus the markdown extension', () => {
        expect(portableFileName('Quantum Mechanics')).toBe('Quantum Mechanics.md')
        expect(portableFileName('A/B')).toBe('A_B.md')
        // The stem is lossy: `etc.` lands on the same base as `etc`, which is why the base
        // alone is never the final word - the allocators suffix it.
        expect(portableFileName('etc.')).toBe('etc.md')
    })
})

describe('suffixedFileName', () => {
    it('numbers from two, before the extension', () => {
        expect(suffixedFileName('Foo.md', 1)).toBe('Foo.md')
        expect(suffixedFileName('Foo.md', 2)).toBe('Foo (2).md')
        expect(suffixedFileName('Foo.md', 3)).toBe('Foo (3).md')
    })
})
