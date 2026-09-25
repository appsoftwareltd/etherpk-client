import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    clampFontSize,
    DEFAULT_FONT_SIZE,
    MAX_FONT_SIZE,
    MIN_FONT_SIZE,
    onEditorFontSizeChange,
    setEditorFontSize,
    zoomEditorFont,
} from './editor-font'

describe('clampFontSize', () => {
    it('keeps an in-range value, rounded to whole px', () => {
        expect(clampFontSize(16)).toBe(16)
        expect(clampFontSize(17.4)).toBe(17)
    })

    it('clamps to the supported range', () => {
        expect(clampFontSize(MIN_FONT_SIZE - 5)).toBe(MIN_FONT_SIZE)
        expect(clampFontSize(MAX_FONT_SIZE + 99)).toBe(MAX_FONT_SIZE)
    })

    it('falls back to the default for a non-finite value', () => {
        expect(clampFontSize(NaN)).toBe(DEFAULT_FONT_SIZE)
        expect(clampFontSize(Infinity)).toBe(DEFAULT_FONT_SIZE)
    })
})

describe('onEditorFontSizeChange', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('tells each subscriber once the new size is on the root, until it unsubscribes', () => {
        const setProperty = vi.fn()
        vi.stubGlobal('document', { documentElement: { style: { setProperty } } })
        // What the root carried when each subscriber heard: an editor measuring earlier would
        // measure the old size.
        const heard: unknown[] = []
        const off = onEditorFontSizeChange(() => heard.push(setProperty.mock.lastCall?.[1]))

        setEditorFontSize(20)
        zoomEditorFont(1)
        off()
        zoomEditorFont(1)

        expect(heard).toEqual(['20px', '21px'])
        expect(setProperty).toHaveBeenLastCalledWith('--editor-font-size', '22px')
    })
})
