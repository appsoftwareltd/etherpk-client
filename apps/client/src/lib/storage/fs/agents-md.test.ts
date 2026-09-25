import { describe, expect, it } from 'vitest'

import {
    AGENTS_MD_BEGIN,
    AGENTS_MD_END,
    AGENTS_MD_FILE,
    CLAUDE_MD_FILE,
    buildAgentsMdSection,
    buildClaudeMdSection,
    ensureAgentInstructions,
    ensureAgentsMd,
    mergeAgentsMdSection,
} from './agents-md'
import { createMemoryDirectoryAdapter } from './memory-adapter'

function tickingAdapter() {
    let clock = 0
    return createMemoryDirectoryAdapter({ now: () => ++clock })
}

describe('the managed section', () => {
    const section = buildAgentsMdSection()

    it('is fenced by the two sentinels, with the do-not-edit warning on the opener', () => {
        expect(section.startsWith(AGENTS_MD_BEGIN)).toBe(true)
        expect(section.endsWith(AGENTS_MD_END)).toBe(true)
        expect(AGENTS_MD_BEGIN).toMatch(/DO NOT EDIT/)
        // A comment, so the section renders as prose in any markdown viewer.
        expect(AGENTS_MD_BEGIN.startsWith('<!--')).toBe(true)
        expect(AGENTS_MD_END.startsWith('<!--')).toBe(true)
    })

    it('tells the reader where their own notes go and that the section is rewritten', () => {
        expect(section).toMatch(/outside (this|the managed) section/i)
        expect(section).toMatch(/rewrit/i)
    })

    it('covers the folder layout, the syntax and the corruption rules', () => {
        // The four content directories and the file itself.
        for (const dir of ['journals/', 'pages/', 'assets/', 'etherpk/']) expect(section).toContain(dir)
        expect(section).toContain('settings.json')
        expect(section).toContain('protection.json')
        // Identity: frontmatter title, ISO-dated journals, scoped concepts, aliases.
        expect(section).toContain('title:')
        expect(section).toContain('aliases:')
        expect(section).toContain('YYYY-MM-DD')
        expect(section).toContain('[[[[Physics]] Quantum Mechanics]]')
        // Syntax: wikilinks, outliner indent, tasks and their tags, fences, math, tables, assets.
        expect(section).toContain('[[')
        expect(section).toMatch(/two spaces/i)
        expect(section).toContain('- [ ]')
        expect(section).toContain('- [x]')
        expect(section).toContain('#P1')
        expect(section).toContain('#D-YYYY-MM-DD')
        expect(section).toContain('```mermaid')
        expect(section).toContain('```math')
        expect(section).toContain('../assets/')
        expect(section).toContain('|300')
        // Protection: the cipher fence is named and marked untouchable.
        expect(section).toContain('```etherpk-cipher')
        expect(section).toMatch(/etherpk-cipher[\s\S]*never/i)
        // Corruption rules: UTF-8, LF, whitespace-only continuation lines, one page per concept.
        expect(section).toMatch(/UTF-8/)
        expect(section).toMatch(/\bLF\b/)
        expect(section).toMatch(/trailing whitespace|whitespace-only/i)
    })

    it('points at the published user docs, for what it does not say itself', () => {
        expect(section).toContain('https://docs.etherpk.com')
        expect(section).toContain('https://docs.etherpk.com/protected-documents')
        expect(section).toContain('https://docs.etherpk.com/local-graphs')
    })

    it('tells a reader nested inside a larger project to point that project here', () => {
        expect(section).toMatch(/larger project/i)
    })

    it('never mentions a CRDT, a sync server or an account: this folder is a local graph', () => {
        // A coding agent reading a local folder has no server to talk to; saying so would only
        // invite it to look for one.
        expect(section).not.toMatch(/\bCRDT\b/)
        expect(section).not.toMatch(/recovery code/i)
    })
})

describe('the CLAUDE.md section', () => {
    const section = buildClaudeMdSection()

    it('is the same sentinel pair around an @AGENTS.md import on its own line, outside any code span', () => {
        // Claude Code reads CLAUDE.md, not AGENTS.md, and its import parser skips code spans and
        // fences - so the import has to be bare text, and it has to be the first thing after
        // the opener so a reader sees where the instructions actually are.
        const lines = section.split('\n')
        expect(lines[0]).toBe(AGENTS_MD_BEGIN)
        expect(lines[1]).toBe('@AGENTS.md')
        expect(lines.at(-1)).toBe(AGENTS_MD_END)
        expect(section).not.toContain('`@AGENTS.md`')
        expect(section).not.toContain('```')
    })

    it('does not repeat the AGENTS.md text, so the two files cannot drift apart', () => {
        expect(section).not.toContain('## EtherPK knowledge graph')
        expect(section.length).toBeLessThan(600)
    })
})

describe('mergeAgentsMdSection', () => {
    const section = `${AGENTS_MD_BEGIN}\nmanaged\n${AGENTS_MD_END}`

    it('creates the file from the section alone when there is nothing on disk', () => {
        expect(mergeAgentsMdSection(null, section)).toBe(`${section}\n`)
    })

    it('appends after existing content, separated by one blank line, keeping the user text verbatim', () => {
        expect(mergeAgentsMdSection('# My notes\n\nDo not delete the archive.\n', section)).toBe(
            `# My notes\n\nDo not delete the archive.\n\n${section}\n`,
        )
    })

    it('adds the missing newline before appending to a file that does not end in one', () => {
        expect(mergeAgentsMdSection('# My notes', section)).toBe(`# My notes\n\n${section}\n`)
    })

    it('replaces only the fenced region, keeping text before and after it', () => {
        const stale = `${AGENTS_MD_BEGIN}\nold managed text\n${AGENTS_MD_END}`
        const existing = `before\n\n${stale}\n\nafter\n`
        expect(mergeAgentsMdSection(existing, section)).toBe(`before\n\n${section}\n\nafter\n`)
    })

    it('treats a begin without an end (a hand-edited file) as no section and appends a fresh one', () => {
        // Replacing from the opener to the end of the file would eat whatever the user wrote
        // below the broken sentinel; appending keeps every byte of theirs.
        const broken = `${AGENTS_MD_BEGIN}\nhalf a section\n\nmy notes\n`
        expect(mergeAgentsMdSection(broken, section)).toBe(`${broken}\n${section}\n`)
    })

    it('normalises CRLF around the section so a Windows-edited file is not left mixed', () => {
        const existing = `# Mine\r\n\r\n${AGENTS_MD_BEGIN}\r\nold\r\n${AGENTS_MD_END}\r\n`
        const merged = mergeAgentsMdSection(existing, section)
        expect(merged).toBe(`# Mine\r\n\r\n${section.replaceAll('\n', '\r\n')}\r\n`)
    })
})

describe('ensureAgentsMd', () => {
    it('creates the file when the graph has none', async () => {
        const adapter = tickingAdapter()
        expect(await ensureAgentsMd(adapter)).toBe('created')
        const file = await adapter.readRootFile(AGENTS_MD_FILE)
        expect(file?.text).toBe(`${buildAgentsMdSection()}\n`)
    })

    it('leaves a current file untouched, so an open never dirties a git checkout', async () => {
        const adapter = tickingAdapter()
        await ensureAgentsMd(adapter)
        const before = await adapter.readRootFile(AGENTS_MD_FILE)
        expect(await ensureAgentsMd(adapter)).toBe('unchanged')
        expect(await adapter.readRootFile(AGENTS_MD_FILE)).toEqual(before)
    })

    it('appends to a file the user wrote and refreshes a stale managed section on the next open', async () => {
        const adapter = tickingAdapter()
        await adapter.writeRootFile(AGENTS_MD_FILE, '# House rules\n\nNever touch pages/Archive.md.\n')
        expect(await ensureAgentsMd(adapter)).toBe('updated')
        let text = (await adapter.readRootFile(AGENTS_MD_FILE))!.text
        expect(text.startsWith('# House rules\n\nNever touch pages/Archive.md.\n\n')).toBe(true)
        expect(text.endsWith(`${AGENTS_MD_END}\n`)).toBe(true)

        // A newer EtherPK ships a different section: the old one is swapped, the user's kept.
        const stale = text.replace(buildAgentsMdSection(), `${AGENTS_MD_BEGIN}\nfrom an older build\n${AGENTS_MD_END}`)
        await adapter.writeRootFile(AGENTS_MD_FILE, stale)
        expect(await ensureAgentsMd(adapter)).toBe('updated')
        text = (await adapter.readRootFile(AGENTS_MD_FILE))!.text
        expect(text).toContain('# House rules')
        expect(text).not.toContain('from an older build')
        expect(text).toContain(buildAgentsMdSection())
    })

    it('ensureAgentInstructions writes both files, AGENTS.md before the CLAUDE.md that imports it', async () => {
        const adapter = tickingAdapter()
        const order: string[] = []
        const watched = {
            ...adapter,
            writeRootFile: async (name: string, text: string) => {
                order.push(name)
                return adapter.writeRootFile(name, text)
            },
        }
        expect(await ensureAgentInstructions(watched)).toEqual({ agents: 'created', claude: 'created' })
        expect(order).toEqual([AGENTS_MD_FILE, CLAUDE_MD_FILE])
        expect((await adapter.readRootFile(CLAUDE_MD_FILE))?.text).toBe(`${buildClaudeMdSection()}\n`)

        // A user's own CLAUDE.md keeps its text, with the import appended.
        await adapter.writeRootFile(CLAUDE_MD_FILE, '# For Claude\n\nUse plan mode.\n')
        expect(await ensureAgentInstructions(adapter)).toEqual({ agents: 'unchanged', claude: 'updated' })
        const claude = (await adapter.readRootFile(CLAUDE_MD_FILE))!.text
        expect(claude.startsWith('# For Claude\n\nUse plan mode.\n\n')).toBe(true)
        expect(claude).toContain('@AGENTS.md')
    })

    it('rejects rather than writes when the file cannot be read', async () => {
        // A revoked permission or a locked file: writing a fresh section over an unreadable
        // file would destroy whatever the user has in it.
        const adapter = tickingAdapter()
        const denied = {
            ...adapter,
            readRootFile: async () => {
                throw new DOMException('permission revoked', 'NotAllowedError')
            },
        }
        await expect(ensureAgentsMd(denied)).rejects.toThrow('permission revoked')
        expect(await adapter.readRootFile(AGENTS_MD_FILE)).toBeNull()
    })
})
