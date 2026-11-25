import { describe, expect, it } from 'vitest'

import { DARK_INK, LIGHT_INK } from '#lib/contrast-ink.js'

import { toolbarAccentStyle } from './toolbar-accent'

describe('toolbarAccentStyle', () => {
    it('carries the colour and the ink that reads on it', () => {
        expect(toolbarAccentStyle('#1e3a8a')).toBe(`--gk-toolbar-accent: #1e3a8a; --gk-toolbar-ink: ${LIGHT_INK}; --gk-toolbar-hover: color-mix(in srgb, ${LIGHT_INK} 16%, transparent);`)
        expect(toolbarAccentStyle('#fcd34d')).toBe(`--gk-toolbar-accent: #fcd34d; --gk-toolbar-ink: ${DARK_INK}; --gk-toolbar-hover: color-mix(in srgb, ${DARK_INK} 16%, transparent);`)
    })

    it('sets nothing without a colour, so the theme decides', () => {
        expect(toolbarAccentStyle(null)).toBe('')
    })
})
