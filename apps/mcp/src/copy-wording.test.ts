import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeCopyViolations, scanCopyWording } from '@appsoftwareltd/etherpk-shared/copy-wording'

describe('copy wording', () => {
    it('says device and create, and no retired name, in what the Headless Client prints and tells agents', () => {
        const violations = scanCopyWording([fileURLToPath(new URL('.', import.meta.url))])
        expect(violations, describeCopyViolations(violations)).toEqual([])
    })
})
