/**
 * The colour and width chosen for each drawing tool, remembered on this device (the extension's
 * own storage), so the next drawing starts with the pen the person last used. Read with care: a
 * stored value from an older release, or one edited by hand, falls back to the defaults.
 */
import type { ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'

import { HIGHLIGHTER_COLOURS, type InkTool, PEN_COLOURS } from './format'

export interface BrushChoice {
    colour: string
    /** Which of the tool's three widths (`WIDTHS`): 0 thin, 1 medium, 2 thick. */
    width: number
}

export type BrushChoices = Record<InkTool, BrushChoice>

const KEY = 'brushes'

export function defaultBrushes(): BrushChoices {
    return { pen: { colour: PEN_COLOURS[0].hex, width: 1 }, highlighter: { colour: HIGHLIGHTER_COLOURS[0].hex, width: 1 } }
}

function choice(value: unknown, palette: readonly { hex: string }[], fallback: BrushChoice): BrushChoice {
    if (typeof value !== 'object' || value === null) return fallback
    const { colour, width } = value as Record<string, unknown>
    return {
        colour: typeof colour === 'string' && palette.some((c) => c.hex === colour) ? colour : fallback.colour,
        width: width === 0 || width === 1 || width === 2 ? width : fallback.width,
    }
}

export const rememberedBrushes = {
    read(storage: ExtensionStorage | null): BrushChoices {
        const defaults = defaultBrushes()
        const stored = storage?.get<Partial<Record<InkTool, unknown>>>(KEY)
        if (!stored || typeof stored !== 'object') return defaults
        return { pen: choice(stored.pen, PEN_COLOURS, defaults.pen), highlighter: choice(stored.highlighter, HIGHLIGHTER_COLOURS, defaults.highlighter) }
    },
    write(storage: ExtensionStorage | null, brushes: BrushChoices): void {
        storage?.set(KEY, { pen: { ...brushes.pen }, highlighter: { ...brushes.highlighter } })
    },
}
