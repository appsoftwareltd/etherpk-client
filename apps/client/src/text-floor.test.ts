import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeTextFloorViolations, scanTextFloor } from '@appsoftwareltd/etherpk-shared/text-floor'

import { DEFAULT_FONT_SIZE } from './lib/document/editor-font'
import { CODE_FONT_SCALE } from './lib/document/view/augmentations/code-highlight'

describe('text size', () => {
    it('sets no text in the Client below 14px and fades none with opacity', () => {
        const violations = scanTextFloor([fileURLToPath(new URL('.', import.meta.url))])
        expect(violations, describeTextFloorViolations(violations)).toEqual([])
    })

    // Code is document text and follows the editor zoom, so the scan cannot hold it to 14px at
    // every size (the constant is not a literal it reads, either); at the default zoom it must be.
    it('sets code at 14px or more at the default editor zoom', () => {
        expect(CODE_FONT_SCALE * DEFAULT_FONT_SIZE).toBeGreaterThanOrEqual(14)
    })
})
