import { describe, expect, it } from 'vitest'

import { onDiskName, portableFileStem, publishSlug } from './derive'

describe('onDiskName', () => {
    it('keeps a plain concept unchanged', () => {
        expect(onDiskName('Quantum Mechanics')).toBe('Quantum Mechanics')
    })

    it('keeps the inner brackets of a scoped concept', () => {
        expect(onDiskName('[[Physics]] Quantum Mechanics')).toBe('[[Physics]] Quantum Mechanics')
    })

    it('replaces filesystem-illegal characters with underscore', () => {
        expect(onDiskName('What is 1/2 + 1/4?')).toBe('What is 1_2 + 1_4_')
        expect(onDiskName('a:b*c|d"e<f>g\\h')).toBe('a_b_c_d_e_f_g_h')
    })
})

describe('portableFileStem', () => {
    it('keeps a plain or scoped concept as it is', () => {
        expect(portableFileStem('Quantum Mechanics')).toBe('Quantum Mechanics')
        expect(portableFileStem('[[Physics]] Quantum')).toBe('[[Physics]] Quantum')
    })

    it('replaces filesystem-illegal and control characters with underscore', () => {
        expect(portableFileStem('TCP/IP')).toBe('TCP_IP')
        expect(portableFileStem('Why?')).toBe('Why_')
        expect(portableFileStem('tab\there')).toBe('tab_here')
        expect(portableFileStem('bell\u0007')).toBe('bell_')
    })

    it('drops trailing dots and spaces, which Windows would drop silently', () => {
        expect(portableFileStem('etc.')).toBe('etc')
        expect(portableFileStem('Inc. ')).toBe('Inc')
        expect(portableFileStem('Draft...')).toBe('Draft')
    })

    it('turns a leading dot into an underscore rather than writing a hidden file', () => {
        expect(portableFileStem('.profile')).toBe('_profile')
        expect(portableFileStem('..')).toBe('_')
    })

    it('never empties out', () => {
        expect(portableFileStem('')).toBe('_')
        expect(portableFileStem('...')).toBe('_')
        expect(portableFileStem('   ')).toBe('_')
    })

    it('suffixes the names Windows reserves for devices, whatever their case', () => {
        expect(portableFileStem('CON')).toBe('CON_')
        expect(portableFileStem('nul')).toBe('nul_')
        expect(portableFileStem('Com1')).toBe('Com1_')
        expect(portableFileStem('LPT9')).toBe('LPT9_')
        expect(portableFileStem('Console')).toBe('Console') // only the exact name is reserved
    })

    it('caps the stem at 200 bytes of UTF-8 without splitting a code point', () => {
        expect(portableFileStem('a'.repeat(300))).toBe('a'.repeat(200))
        // Three bytes each: 66 fit in 198 bytes, a 67th would need 201.
        expect(portableFileStem('€'.repeat(100))).toBe('€'.repeat(66))
        // A trailing dot exposed by the cut is dropped too.
        expect(portableFileStem('a'.repeat(199) + '.' + 'b'.repeat(10))).toBe('a'.repeat(199))
    })

    it('is many-to-one, which is the allocators’ problem, not this function’s', () => {
        // `etc` and `etc.` are distinct concepts on one stem: `allocateFileName` (Filesystem
        // Backend) and `planMirrorNames` (Local Mirror) suffix the FILE, never the title.
        expect(portableFileStem('etc.')).toBe(portableFileStem('etc'))
        expect(portableFileStem('A/B')).toBe(portableFileStem('A_B'))
    })
})

describe('publishSlug', () => {
    it('lowercases and hyphenates spaces and underscores', () => {
        expect(publishSlug('Quantum Mechanics')).toBe('quantum-mechanics')
        expect(publishSlug('Daily_Notes 2026')).toBe('daily-notes-2026')
    })

    it('drops punctuation and collapses/trims hyphens', () => {
        expect(publishSlug('  Hello, World!  ')).toBe('hello-world')
        expect(publishSlug('[[Physics]] Quantum Mechanics')).toBe('physics-quantum-mechanics')
    })
})
