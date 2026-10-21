import { describe, expect, it } from 'vitest'

import { agentsMdWithManagedSection, publishedPublicationOf, seededFiles } from './seeded'
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
        for (const path of ['.git', '.github', 'wrangler.jsonc', 'AGENTS.md', 'README.md']) expect(ignore.split('\n')).toContain(path)
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

    it('seeds no workflow into a Publish Repository, and tells its README to serve the branch', () => {
        // GitHub refuses a commit that adds a workflow unless the token may change workflows, and
        // Pages can serve a branch without one (ADR 0152).
        const files = seededFiles(publication, 'repository')
        expect(files.has('.github/workflows/pages.yaml')).toBe(false)
        expect(files.get('README.md')).toContain('Deploy from a branch')
        expect(files.get('README.md')).not.toContain('pages.yaml')
        expect(files.has('wrangler.jsonc')).toBe(true)
    })

    it('words the managed section the same for a folder and a repository, so publishing from both never flips it', () => {
        const section = agentsMdWithManagedSection(null, publication)
        expect(section).toContain('Deploy from a branch')
        expect(section).toMatch(/straight to its repository/)
    })
})

describe('publishedPublicationOf', () => {
    it('reads the publication a site folder holds from its AGENTS.md', () => {
        expect(publishedPublicationOf(agentsMdWithManagedSection('# Mine\n', publication))).toBe('docs')
        expect(publishedPublicationOf(agentsMdWithManagedSection(null, { ...publication, id: 'garden-blog' }))).toBe('garden-blog')
    })

    it('finds none in an AGENTS.md without the section, or with none at all', () => {
        expect(publishedPublicationOf(null)).toBeNull()
        expect(publishedPublicationOf('# Mine\n\nfrom the publication `docs`\n')).toBeNull()
        expect(publishedPublicationOf('<!-- etherpk:start -->\n## EtherPK knowledge graph\n<!-- etherpk:end -->')).toBeNull()
    })
})
