import { describe, expect, it } from 'vitest'

import { MAX_PREPARED_EDGE, preparedSize } from './extension-assets'

describe('the size an image is sent to a model at (ADR 0147)', () => {
    it('leaves an image whose long side fits as it is', () => {
        expect(preparedSize(1600, 900)).toEqual({ width: 1600, height: 900 })
        expect(preparedSize(MAX_PREPARED_EDGE, 10)).toEqual({ width: MAX_PREPARED_EDGE, height: 10 })
    })

    it('scales a larger one down to fit, keeping its shape', () => {
        expect(preparedSize(4000, 3000)).toEqual({ width: 2048, height: 1536 })
        expect(preparedSize(1000, 8192)).toEqual({ width: 250, height: 2048 })
    })

    it('never scales a side below one pixel', () => {
        expect(preparedSize(100_000, 1)).toEqual({ width: 2048, height: 1 })
    })
})
