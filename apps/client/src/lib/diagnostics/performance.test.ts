import { describe, expect, it } from 'vitest'
import { createPerformanceRecorder } from './performance'

describe('performance recorder', () => {
    it('records stable numeric diagnostics without retaining operation input', async () => {
        let time = 10
        const recorder = createPerformanceRecorder({ enabled: true, now: () => ++time })
        const secretContent = 'private note body'

        expect(recorder.measure('editor.transaction', { lines: 1_000 }, () => secretContent.length)).toBe(
            secretContent.length,
        )
        await recorder.measureAsync('sync.catchup', { rows: 12, bytes: 4_096 }, async () => {})

        const encoded = JSON.stringify(recorder.snapshot())
        expect(encoded).not.toContain(secretContent)
        expect(recorder.snapshot().map((metric) => metric.name)).toEqual([
            'editor.transaction',
            'sync.catchup',
        ])
    })

    it('is a no-op while disabled and rejects data-shaped metric names', () => {
        const disabled = createPerformanceRecorder({ enabled: false })
        disabled.mark('document Physics')
        expect(disabled.snapshot()).toEqual([])

        const enabled = createPerformanceRecorder({ enabled: true, now: () => 1 })
        expect(() => enabled.mark('document Physics')).toThrow(/stable identifiers/)
    })

    it('bounds retained diagnostics', () => {
        const recorder = createPerformanceRecorder({ enabled: true, capacity: 2, now: () => 1 })
        recorder.mark('one')
        recorder.mark('two')
        recorder.mark('three')
        expect(recorder.snapshot().map((metric) => metric.name)).toEqual(['two', 'three'])
    })
})
