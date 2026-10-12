import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { AGENTS_MD_FILE, CLAUDE_MD_FILE, ensureAgentInstructions } from './agents-md'
import { createMemoryDirectoryAdapter } from './memory-adapter'

/**
 * The `etherpk` Agent Skill's starter Graph Folders carry the `AGENTS.md` and `CLAUDE.md` that
 * EtherPK writes into an empty folder, byte for byte (ADR 0070, amended 2026-10-12). An agent
 * copies a starter to make a new graph before EtherPK has ever opened it, and reads that
 * `AGENTS.md` as its description of the format. Generated from the same code the app runs, so
 * the skill can never describe a different format, and EtherPK's first open of a folder made
 * from a starter finds its own section and writes nothing.
 *
 * After a change to `agents-md-section.md`, `vitest run -u` rewrites the copies. CI never writes
 * them, so a stale copy fails there.
 */

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url))

/** The skill's folder: under public-repos/client here, at the root of the etherpk-client repository. */
const SKILL = ['public-repos/client/skills/etherpk', 'skills/etherpk']
    .map((path) => join(REPO, path))
    .find((path) => existsSync(join(path, 'SKILL.md')))

describe.each(['docs', 'blog'])('the %s starter', (starter) => {
    it('carries the AGENTS.md and CLAUDE.md EtherPK writes into an empty folder', async () => {
        expect(SKILL, 'the etherpk skill folder, with its SKILL.md').toBeDefined()
        let clock = 0
        const adapter = createMemoryDirectoryAdapter({ now: () => ++clock })
        expect(await ensureAgentInstructions(adapter)).toEqual({ agents: 'created', claude: 'created' })

        const agents = await adapter.readRootFile(AGENTS_MD_FILE)
        const claude = await adapter.readRootFile(CLAUDE_MD_FILE)
        await expect(agents?.text).toMatchFileSnapshot(join(SKILL!, 'assets', starter, AGENTS_MD_FILE))
        await expect(claude?.text).toMatchFileSnapshot(join(SKILL!, 'assets', starter, CLAUDE_MD_FILE))
    })
})
