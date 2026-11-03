import type { ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it } from 'vitest'

import { defaultBrushes, rememberedBrushes } from './brushes'

function memory(): ExtensionStorage {
    const values = new Map<string, unknown>()
    return { get: <T>(key: string) => values.get(key) as T | undefined, set: (key, value) => void values.set(key, value), remove: (key) => void values.delete(key) }
}

describe('the brushes remembered on this device', () => {
    it('starts with a black medium pen and a yellow medium highlighter', () => {
        expect(rememberedBrushes.read(null)).toEqual(defaultBrushes())
        expect(defaultBrushes()).toEqual({ pen: { colour: '#1e1e1e', width: 1 }, highlighter: { colour: '#ffd43b', width: 1 } })
    })

    it('keeps what was chosen', () => {
        const storage = memory()
        rememberedBrushes.write(storage, { pen: { colour: '#e03131', width: 2 }, highlighter: { colour: '#a5d8ff', width: 0 } })
        expect(rememberedBrushes.read(storage)).toEqual({ pen: { colour: '#e03131', width: 2 }, highlighter: { colour: '#a5d8ff', width: 0 } })
    })

    it('falls back to the defaults for what it cannot read', () => {
        const storage = memory()
        storage.set('brushes', { pen: { colour: '#123456', width: 7 }, highlighter: 'yellow' })
        expect(rememberedBrushes.read(storage)).toEqual(defaultBrushes())
    })
})
