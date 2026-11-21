import { describe, expect, it } from 'vitest'

import { DEFAULT_FONT_SIZE } from '#lib/document/editor-font.js'

import { contentWidthStyle } from './content-width'

describe('contentWidthStyle', () => {
    it('sets the width as a multiple of the zoomed text size, so it follows the editor zoom', () => {
        expect(contentWidthStyle(DEFAULT_FONT_SIZE * 50)).toBe(`--gk-content-max-width: calc(var(--editor-font-size, ${DEFAULT_FONT_SIZE}px) * 50);`)
        expect(contentWidthStyle(900)).toBe(`--gk-content-max-width: calc(var(--editor-font-size, ${DEFAULT_FONT_SIZE}px) * ${900 / DEFAULT_FONT_SIZE});`)
    })

    it('sets the whole width when there is no limit', () => {
        expect(contentWidthStyle(null)).toBe('--gk-content-max-width: 100%;')
    })
})
