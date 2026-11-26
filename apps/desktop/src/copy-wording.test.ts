import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeCopyViolations, scanCopyWording } from '../../../packages/shared/src/testing/copy-wording.ts'

describe('copy wording', () => {
    it('says device and create, and no retired name, in what the desktop app shows', () => {
        const violations = scanCopyWording([fileURLToPath(new URL('./copy.ts', import.meta.url)), fileURLToPath(new URL('./auth/loopback.ts', import.meta.url)), fileURLToPath(new URL('./update/updates.ts', import.meta.url))])
        expect(violations, describeCopyViolations(violations)).toEqual([])
    })
})
