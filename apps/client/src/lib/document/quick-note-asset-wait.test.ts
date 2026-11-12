import { describe, expect, it } from 'vitest'
import { QUICK_NOTE_ASSET_RETRIES, quickNoteAssetWait } from './quick-note-asset-wait'

describe('quickNoteAssetWait', () => {
    it('doubles from two seconds and stops growing at a minute', () => {
        expect([0, 1, 2, 3, 4, 5, 6].map(quickNoteAssetWait)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
    })

    it('asks for about a quarter of an hour, then no more', () => {
        const waits = Array.from({ length: QUICK_NOTE_ASSET_RETRIES }, (_, retry) => quickNoteAssetWait(retry) ?? 0)
        const total = waits.reduce((sum, wait) => sum + wait, 0)
        expect(total).toBeGreaterThan(14 * 60_000)
        expect(total).toBeLessThan(16 * 60_000)
        expect(quickNoteAssetWait(QUICK_NOTE_ASSET_RETRIES)).toBeNull()
    })
})
