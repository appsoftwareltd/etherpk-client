import { describe, expect, it } from 'vitest'

import { describeExportEstimate } from './mirror-tab'

describe('describeExportEstimate', () => {
    it('gives the size as the attachments’, which is what it measures', () => {
        expect(describeExportEstimate({ documents: 12, assets: 3, bytes: 4 * 1024 * 1024 })).toBe(
            '12 documents and 3 attachments. The attachments are about 4 MiB.',
        )
        expect(describeExportEstimate({ documents: 1, assets: 1, bytes: 512 })).toBe(
            '1 document and 1 attachment. The attachments are about 512 B.',
        )
    })

    it('names no size for a graph with no attachments, rather than "about 0 B"', () => {
        expect(describeExportEstimate({ documents: 3, assets: 0, bytes: 0 })).toBe('3 documents and no attachments.')
    })
})
