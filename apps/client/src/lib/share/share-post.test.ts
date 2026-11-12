import { describe, expect, it } from 'vitest'

import { shareAddress, sharedFilesOf } from './share-post'

function form(fields: Record<string, string>, files: File[] = []): FormData {
    const data = new FormData()
    for (const [name, value] of Object.entries(fields)) data.set(name, value)
    for (const file of files) data.append('files', file)
    return data
}

describe('a posted share', () => {
    it('becomes the address the share page reads, with only the fields that arrived', () => {
        expect(shareAddress(form({ title: 'Growing beans', text: '', url: 'https://example.com/beans' }), null)).toBe(
            '/share?title=Growing+beans&url=https%3A%2F%2Fexample.com%2Fbeans',
        )
    })

    it('names where its files are kept', () => {
        expect(shareAddress(form({ text: 'corner shop' }), 'abc')).toBe('/share?text=corner+shop&files=abc')
        expect(shareAddress(form({}), 'dropped')).toBe('/share?files=dropped')
    })

    it('is the bare page for a post with nothing in it', () => {
        expect(shareAddress(form({}), null)).toBe('/share')
    })

    it('counts a file with bytes, and not the empty field a share of text carries', () => {
        const files = sharedFilesOf(form({ text: 'beans' }, [new File(['x'], 'receipt.png'), new File([], '')]))
        expect(files.map((file) => file.name)).toEqual(['receipt.png'])
    })
})
