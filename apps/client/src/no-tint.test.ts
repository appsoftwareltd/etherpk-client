import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeTintViolations, scanTints } from '@appsoftwareltd/etherpk-shared/no-tint'

describe('tints', () => {
    // The Built-in Extensions draw in the Client, so their source is held to the same rule.
    it('draws no tinted grey and no pale wash of blue or purple, nor do the extensions', () => {
        const extensions = fileURLToPath(new URL('../../../extensions/', import.meta.url))
        const roots = readdirSync(extensions, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
            .map((entry) => `${extensions}${entry.name}/src`)
        const violations = scanTints([fileURLToPath(new URL('.', import.meta.url)), ...roots])
        expect(violations, describeTintViolations(violations)).toEqual([])
    })
})
