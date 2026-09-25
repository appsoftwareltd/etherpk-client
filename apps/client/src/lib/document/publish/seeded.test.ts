import { describe, expect, it } from 'vitest'

import { agentsMdWithManagedSection, seededFiles } from './seeded'
import type { Publication } from './types'

const publication: Publication = { id: 'docs', name: 'Docs', concept: 'Docs Site', kind: 'docs', selection: 'named', theme: 'etherpk-docs', recent: 10, includes: {}, outline: '' }

describe('seeded files', () => {
    it('seeds a Pages workflow with no build step, a wrangler config and a README naming the publication', () => {
        const files = seededFiles(publication)
        expect(files.get('.github/workflows/pages.yaml')).toContain('upload-pages-artifact')
        // The Worker carries the publication's id as it is: a suffix made the name differ from
        // the site repository and the Worker people had already created (2026-09-19).
        expect(files.get('wrangler.jsonc')).toContain('"name": "docs",')
        expect(files.get('README.md')).toContain('`docs`')
        // Wrangler uploads everything under the assets directory, the repository's .git included,
        // unless an .assetsignore says otherwise (found the hard way on docs.etherpk.com, 2026-09-19).
        const ignore = files.get('.assetsignore') as string
        for (const path of ['.git', '.github', 'wrangler.jsonc', 'AGENTS.md', 'README.md', 'etherpk-publish.json']) expect(ignore.split('\n')).toContain(path)
    })

    it('adds a managed section to a fresh AGENTS.md and rewrites only that section later', () => {
        const fresh = agentsMdWithManagedSection(null, publication)
        expect(fresh.startsWith('<!-- etherpk:start -->')).toBe(true)
        const mine = `# My notes\n\nKeep the CNAME.\n\n${fresh}\n\nMore of mine.\n`
        const rewritten = agentsMdWithManagedSection(mine, { ...publication, name: 'Renamed' })
        expect(rewritten).toContain('# My notes')
        expect(rewritten).toContain('More of mine.')
        expect(rewritten).toContain('"Renamed"')
        expect(rewritten.match(/etherpk:start/g)).toHaveLength(1)
    })

    it('appends the section to an AGENTS.md that has none', () => {
        expect(agentsMdWithManagedSection('# Mine\n', publication)).toMatch(/^# Mine\n\n<!-- etherpk:start -->/)
    })
})
