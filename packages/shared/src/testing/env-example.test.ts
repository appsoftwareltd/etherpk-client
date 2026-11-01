import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    compareEnvExample,
    environmentNamesInSource,
    environmentNamesInTree,
    parseEnvExampleKeys,
    undeclaredSettings,
} from './env-example'

describe('parseEnvExampleKeys', () => {
    it('reads set and commented-out assignments, and ignores prose comments', () => {
        const keys = parseEnvExampleKeys(
            [
                '# The database the server reads and writes.',
                'DATABASE_APPLICATION_URL=postgres://etherpk:etherpk@localhost:5432/etherpk_sync',
                '',
                '# Optional. Leave unset to keep uploads off.',
                '# S3_BUCKET=etherpk-assets',
                '#S3_REGION=auto',
                'EMPTY_ON_PURPOSE=',
                '# Turn this on: DO_NOT_COUNT_THIS=1 is inside prose',
            ].join('\n'),
        )
        expect([...keys].sort()).toEqual(['DATABASE_APPLICATION_URL', 'EMPTY_ON_PURPOSE', 'S3_BUCKET', 'S3_REGION'])
    })

    it('accepts Windows line endings', () => {
        expect([...parseEnvExampleKeys('PORT=3000\r\n# HOST=0.0.0.0\r\n')].sort()).toEqual(['HOST', 'PORT'])
    })
})

describe('environmentNamesInSource', () => {
    it('finds property reads on env, environment and process.env', () => {
        const names = environmentNamesInSource(
            'const a = env.LOG_LEVEL; const b = environment.PUBLIC_CUSTOM_SYNC_URL; const c = process.env.SYNC_PUBLIC_URL',
        )
        expect([...names].sort()).toEqual(['LOG_LEVEL', 'PUBLIC_CUSTOM_SYNC_URL', 'SYNC_PUBLIC_URL'])
    })

    it('finds property reads on the privateEnv and publicEnv names a page gives the two modules', () => {
        const names = environmentNamesInSource('const a = privateEnv.TERMS_URL; const b = publicEnv.PUBLIC_TERMS_URL')
        expect([...names].sort()).toEqual(['PUBLIC_TERMS_URL', 'TERMS_URL'])
    })

    it('finds quoted upper-snake names passed to any reader', () => {
        const names = environmentNamesInSource(
            "required(environment, 'CORPORATE_ISSUER'); getEnv(\"SYNC_TOKEN_SECRET\"); const keys = [`S3_BUCKET`]",
        )
        expect([...names].sort()).toEqual(['CORPORATE_ISSUER', 'S3_BUCKET', 'SYNC_TOKEN_SECRET'])
    })

    it("finds names imported from SvelteKit's environment modules", () => {
        const names = environmentNamesInSource(
            [
                "import { LOG_LEVEL, OPENOBSERVE_URL as url } from '$app/env/private'",
                'import {',
                '    PUBLIC_DICTIONARY_URL,',
                '    PORT,',
                "} from \"$app/env/public\"",
                "import { dev } from '$app/env'",
            ].join('\n'),
        )
        expect([...names].sort()).toEqual(['LOG_LEVEL', 'OPENOBSERVE_URL', 'PUBLIC_DICTIONARY_URL'])
    })

    it('is not misled by a block-comment opener inside a line comment', () => {
        const names = environmentNamesInSource(
            ['// Handle /api/auth/** requests here', 'const header = env.ADDRESS_HEADER', '/** A later doc comment. */'].join('\n'),
        )
        expect([...names]).toEqual(['ADDRESS_HEADER'])
    })

    it('ignores names that appear only in comments', () => {
        const names = environmentNamesInSource(
            [
                '/**',
                " * Usage: getEnv('DOC_EXAMPLE_ONLY', false)",
                ' */',
                "// getEnv('LINE_COMMENT_ONLY')",
                "const real = getEnv('REAL_SETTING')",
            ].join('\n'),
        )
        expect([...names]).toEqual(['REAL_SETTING'])
    })

    it('does not treat single words or lower-case strings as names', () => {
        expect(
            environmentNamesInSource("const a = 'DEV'; const b = 'log_level'; const c = 'Mixed_Case'; env.DEV; env('PORT')").size,
        ).toBe(0)
    })
})

describe('environmentNamesInTree', () => {
    let root: string | undefined

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true })
        root = undefined
    })

    it('reads .ts, .js and .svelte sources and skips tests, mocks and declarations', () => {
        root = mkdtempSync(join(tmpdir(), 'env-example-'))
        mkdirSync(join(root, 'lib', '__mocks__'), { recursive: true })
        writeFileSync(join(root, 'lib', 'config.ts'), "getEnv('FROM_TS')")
        writeFileSync(join(root, 'lib', 'Page.svelte'), '<script>const u = env.FROM_SVELTE</script>')
        writeFileSync(join(root, 'lib', 'server.js'), 'process.env.FROM_JS')
        writeFileSync(join(root, 'lib', 'config.test.ts'), "getEnv('FROM_TEST')")
        writeFileSync(join(root, 'lib', 'types.d.ts'), "declare const X: 'FROM_DECLARATION'")
        writeFileSync(join(root, 'lib', '__mocks__', 'env.ts'), "export const env = { 'FROM_MOCK': '' }")
        writeFileSync(join(root, 'lib', 'notes.md'), "getEnv('FROM_MARKDOWN')")

        expect([...environmentNamesInTree([root])].sort()).toEqual(['FROM_JS', 'FROM_SVELTE', 'FROM_TS'])
    })

    it('accepts a single file as a root', () => {
        root = mkdtempSync(join(tmpdir(), 'env-example-'))
        writeFileSync(join(root, 'server.ts'), "env('SYNC_REPLICA_COUNT', '1')")
        expect([...environmentNamesInTree([join(root, 'server.ts')])]).toEqual(['SYNC_REPLICA_COUNT'])
    })
})

describe('compareEnvExample', () => {
    it('reports names the source reads that the example lacks, and example keys nothing reads', () => {
        const result = compareEnvExample({
            exampleKeys: new Set(['PORT', 'DATABASE_APPLICATION_URL', 'REMOVED_LONG_AGO']),
            sourceNames: new Set(['DATABASE_APPLICATION_URL', 'NEW_SETTING', 'STALE_GENERATION']),
            notEnvironment: { STALE_GENERATION: 'a sync error code' },
            readOutsideSource: { PORT: 'read by adapter-node' },
        })
        expect(result).toEqual({
            missingFromExample: ['NEW_SETTING'],
            unreadInExample: ['REMOVED_LONG_AGO'],
            listedButKeptOut: [],
        })
    })

    it('leaves out settings kept out of the example, and fails if the example lists one', () => {
        const result = compareEnvExample({
            exampleKeys: new Set(['PORT', 'DEPLOYMENT_ONLY_B']),
            sourceNames: new Set(['DEPLOYMENT_ONLY_A', 'DEPLOYMENT_ONLY_B']),
            notEnvironment: {},
            readOutsideSource: { PORT: 'read by adapter-node' },
            keptOutOfExample: ['DEPLOYMENT_ONLY_A', 'DEPLOYMENT_ONLY_B'],
        })
        expect(result).toEqual({
            missingFromExample: [],
            unreadInExample: [],
            listedButKeptOut: ['DEPLOYMENT_ONLY_B'],
        })
    })

    it('passes when the example and the source agree', () => {
        expect(
            compareEnvExample({
                exampleKeys: new Set(['A_B']),
                sourceNames: new Set(['A_B']),
                notEnvironment: {},
                readOutsideSource: {},
            }),
        ).toEqual({ missingFromExample: [], unreadInExample: [], listedButKeptOut: [] })
    })
})

describe('undeclaredSettings', () => {
    it('lists settings the source reads that src/env.ts does not declare', () => {
        expect(undeclaredSettings({
            sourceNames: new Set(['LOG_LEVEL', 'S3_BUCKET', 'STALE_EPOCH', 'GIT_COMMIT']),
            declared: ['LOG_LEVEL'],
            notEnvironment: { STALE_EPOCH: 'an error code' },
            readOutsideSvelteKit: { GIT_COMMIT: 'read from process.env by the build' },
        })).toEqual(['S3_BUCKET'])
    })
})
