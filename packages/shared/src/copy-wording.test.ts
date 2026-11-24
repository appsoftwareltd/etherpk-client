import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { describeCopyViolations, scanCopyWording } from './testing/copy-wording'

describe('copy wording', () => {
    it('says device and create, and no retired name, in the pages and messages the apps share', () => {
        const source = fileURLToPath(new URL('.', import.meta.url))
        // `testing` holds the scanner, whose patterns spell out the words it refuses.
        const roots = readdirSync(source).filter((name) => name !== 'testing' && name !== 'copy-wording.test.ts')
        const violations = scanCopyWording(roots.map((name) => `${source}${name}`))
        expect(violations, describeCopyViolations(violations)).toEqual([])
    })
})
