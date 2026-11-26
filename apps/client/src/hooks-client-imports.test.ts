import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `hooks.client.ts` sets Zod's `jitless` before any schema is built, and an ES module's imports run
 * before its body. A module it imports that builds a schema as it loads (the shared package does) is
 * compiled first, with `new Function`, which Trusted Types refuses on every page.
 */
const HOOKS = readFileSync(join(import.meta.dirname, 'hooks.client.ts'), 'utf8')
const SCHEMA_FREE = new Set(['zod', '#lib/native/sync-server.js', '#lib/security/trusted-types.js', '#lib/sync/shell-sync-server.js'])

describe('what hooks.client.ts imports', () => {
    it('is only modules that build no Zod schema as they load', () => {
        const imported = [...HOOKS.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((match) => match[1])
        for (const specifier of imported) {
            expect(SCHEMA_FREE.has(specifier), `hooks.client.ts imports ${specifier}. Import only modules that build no Zod schema as they load, or Zod compiles it before jitless is set: add it here once you have checked.`).toBe(true)
        }
    })
})
