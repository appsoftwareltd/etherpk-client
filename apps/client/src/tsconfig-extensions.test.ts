import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { compiledInExtensionFolders } from '../compiled-in-extensions'

/**
 * The compiled-in Built-in Extensions are type-checked with the Client, as its own code is
 * (ADR 0121): they compile with it, and the Client reaches them only through a glob, which the type
 * checker does not follow. SvelteKit 3 took away the config hook that added them to the generated
 * tsconfig, so tsconfig.json names each one, and this test keeps that list complete.
 */
describe('tsconfig.json', () => {
    it('includes the source of every compiled-in extension', () => {
        const path = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
        // TypeScript's own reader, since tsconfig.json carries comments.
        const tsconfig = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8')).config as { include: string[] }
        const included = tsconfig.include.filter((entry) => entry.startsWith('../../extensions/'))
        expect(included).toEqual(compiledInExtensionFolders().map((folder) => `../../extensions/${folder}/src`))
    })
})
