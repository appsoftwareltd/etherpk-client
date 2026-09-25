import { describe, expect, it } from 'vitest'
import { isSafeAssetName, isSingleFileName } from './asset-names'

describe('isSafeAssetName', () => {
    it('accepts the names assets are saved under', () => {
        for (const name of ['photo.png', 'photo.a1b2c3d4.png', 'Quarterly Report.pdf', 'x.9f0e1d2c-3b4a-4c5d-8e7f-001122334455.webp', 'odd%2Fbut-literal.png', 'naïve café.jpg']) {
            expect(isSafeAssetName(name)).toBe(true)
        }
    })

    it('refuses anything that is not a single file name inside assets/', () => {
        for (const name of ['', '.', '..', '../pages/Secret.md', 'a/b.png', 'a\\b.png', '..\\x', 'a\u0000b.png', 'tab\there.png', 'new\nline.png', '\u007f.png']) {
            expect(isSafeAssetName(name)).toBe(false)
        }
    })
})

describe('isSingleFileName', () => {
    it('accepts any one directory entry, odd characters included', () => {
        for (const name of ['Plan.md', 'tab\there.md', '%2e%2e', '...']) expect(isSingleFileName(name)).toBe(true)
    })

    it('refuses paths, dot entries and NUL', () => {
        for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\u0000b']) expect(isSingleFileName(name)).toBe(false)
    })
})
