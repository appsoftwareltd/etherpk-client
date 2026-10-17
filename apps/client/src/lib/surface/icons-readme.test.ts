import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { clientIconNames } from './icons'

/**
 * The Client's icon names are Stable since 0.14.0 (ADR 0120, amended 2026-10-17): an extension may
 * name any of them, so the Extension API's README lists every one, and none is taken away.
 */
const readme = readFileSync(fileURLToPath(new URL('../../../../../packages/extension-api/README.md', import.meta.url)), 'utf8')

describe("the Client's icons as the Extension API lists them", () => {
    it('are listed in the README, every one and no other', () => {
        const start = readme.indexOf('\n### Icons')
        const end = readme.indexOf('\n#', start + 1)
        expect(start).toBeGreaterThan(-1)
        const listed = [...readme.slice(start, end).matchAll(/`([a-z][a-z0-9-]*)`/g)].map((match) => match[1]).filter((name) => name !== 'icon')
        expect(listed.sort()).toEqual(clientIconNames())
    })
})
