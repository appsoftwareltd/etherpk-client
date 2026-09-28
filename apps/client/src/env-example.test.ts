import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    compareEnvExample,
    environmentNamesInTree,
    parseEnvExampleKeys,
} from '@appsoftwareltd/etherpk-shared/env-example'

/** A path relative to `apps/client`. */
const fromApp = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

describe('.env.example', () => {
    it('names every setting the Client reads, and nothing it does not', () => {
        const result = compareEnvExample({
            exampleKeys: parseEnvExampleKeys(readFileSync(fromApp('.env.example'), 'utf8')),
            sourceNames: environmentNamesInTree([fromApp('src')]),
            notEnvironment: {
                BAD_INDENT: 'an error code of the yaml parser, read to word a frontmatter problem',
                BLOCK_AS_IMPLICIT_KEY: 'an error code of the yaml parser, read to word a frontmatter problem',
                DUPLICATE_KEY: 'an error code of the yaml parser, read to word a frontmatter problem',
                MISSING_CHAR: 'an error code of the yaml parser, read to word a frontmatter problem',
                MULTILINE_IMPLICIT_KEY: 'an error code of the yaml parser, read to word a frontmatter problem',
                TAB_AS_INDENT: 'an error code of the yaml parser, read to word a frontmatter problem',
                NOT_A_MAPPING: 'the frontmatter problem code for a block that is not key: value lines',
                QUOTE_DOUBLE: 'a yaml scalar style, read when restyling frontmatter',
                QUOTE_SINGLE: 'a yaml scalar style, read when restyling frontmatter',
            },
            readOutsideSource: {
                HOST: 'read by the SvelteKit Node adapter',
                PORT: 'read by the SvelteKit Node adapter',
                ADDRESS_HEADER: 'read by the SvelteKit Node adapter',
                XFF_DEPTH: 'read by the SvelteKit Node adapter',
                ORIGIN: 'read by the SvelteKit Node adapter',
                PROTOCOL_HEADER: 'read by the SvelteKit Node adapter',
                HOST_HEADER: 'read by the SvelteKit Node adapter',
            },
            // Settings of a hosted deployment that the self-hosting example does not describe.
            keptOutOfExample: [
                'PUBLIC_MANAGED_SYNC_URL',
                'CORPORATE_ISSUER',
                'MANAGED_OAUTH_CLIENT_ID',
                'MANAGED_SYNC_URL',
                'CLIENT_SESSION_SECRET',
                'CLIENT_PUBLIC_URL',
            ],
        })
        expect(result).toEqual({ missingFromExample: [], unreadInExample: [], listedButKeptOut: [] })
    })
})
