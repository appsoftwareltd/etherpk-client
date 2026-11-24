import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeCopyViolations, scanCopyWording } from '@appsoftwareltd/etherpk-shared/copy-wording'

describe('copy wording', () => {
    // The Built-in Extensions speak in the Client, so their source is held to the same rule.
    it('says device and create, and no retired name, in what the Client and the extensions show', () => {
        const extensions = fileURLToPath(new URL('../../../extensions/', import.meta.url))
        const roots = readdirSync(extensions, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
            .map((entry) => `${extensions}${entry.name}/src`)
        const violations = scanCopyWording([fileURLToPath(new URL('.', import.meta.url)), ...roots])
        expect(violations, describeCopyViolations(violations)).toEqual([])
    })
})
