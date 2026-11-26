import { describe, expect, it } from 'vitest'

import { BLOCK_TITLE_LIMIT, blockTitleText } from './block-title'

describe('blockTitleText', () => {
    it('reads wikilinks as their names, nested ones included', () => {
        expect(blockTitleText('- [[[[Garden]] Beds]]')).toBe('Garden Beds')
        expect(blockTitleText('  - [[Kitchen]] vs [[Shed]]')).toBe('Kitchen vs Shed')
    })

    it('drops the marker, the checkbox and the task tags', () => {
        expect(blockTitleText('- [ ] #P1 #D-2026-12-01 water the beans')).toBe('water the beans')
        expect(blockTitleText('- [x] water the beans')).toBe('water the beans')
    })

    it('drops emphasis, highlight, code and strike markers', () => {
        expect(blockTitleText('- **Size:** 27.5 _wide_ ==tall== `code` ~~old~~')).toBe('Size: 27.5 wide tall code old')
    })

    it('reads a link as its text and an image as its file’s name', () => {
        expect(blockTitleText('- see [the shop](https://shop.example/a)')).toBe('see the shop')
        expect(blockTitleText('- ![image-2026-01-02|800](../assets/image-2026-01-02.6ca67cf7-f9dd-4838-8a41-007d06a0adf6.webp)')).toBe('image-2026-01-02.webp')
    })

    it('is empty for a bullet with no words', () => {
        expect(blockTitleText('- ')).toBe('')
    })

    it('is cut to the limit with an ellipsis', () => {
        const long = `- ${'beans '.repeat(30)}`
        const title = blockTitleText(long)
        expect(title.length).toBe(BLOCK_TITLE_LIMIT)
        expect(title.endsWith('…')).toBe(true)
    })
})
