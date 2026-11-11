import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { deriveDoc } from '../document/index-derive'
import { wikilinkOccurrencesInSource } from '../document/wikilink/source'
import {
    FOLDER_WALK_LIMIT,
    WELCOME_PAGE_TITLE,
    WELCOME_TRY_LINES,
    createWelcomeClaims,
    isFolderCreatedEmpty,
    seedWelcomePage,
    welcomePageBody,
    type FolderListing,
    type WelcomeClaims,
} from './welcome-page'

/** A `Storage` stand-in: the three calls the claims make. */
function memoryStorage() {
    const values = new Map<string, string>()
    return {
        values,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
    }
}

const DEMO = 'https://notes.example.com/demo'

describe('the Welcome page text', () => {
    const lines = welcomePageBody(DEMO).split('\n')

    it('is short, and ends with a newline', () => {
        expect(lines.length).toBeLessThanOrEqual(18)
        expect(welcomePageBody(DEMO).endsWith('\n')).toBe(true)
    })

    it('holds the lines a person can try, together and in order', () => {
        expect(welcomePageBody(DEMO)).toContain(WELCOME_TRY_LINES.join('\n'))
    })

    it('shows a bullet, a bullet nested by two spaces, a task, a link to a page that does not exist and the command menu', () => {
        expect(WELCOME_TRY_LINES.some((line) => /^- (?!\[)/.test(line))).toBe(true)
        expect(WELCOME_TRY_LINES.some((line) => /^ {2}- /.test(line))).toBe(true)
        expect(WELCOME_TRY_LINES.some((line) => line.startsWith('- [ ] '))).toBe(true)
        expect(wikilinkOccurrencesInSource(WELCOME_TRY_LINES.join('\n')).map((link) => link.concept)).toEqual(['Reading List'])
        expect(WELCOME_TRY_LINES.some((line) => line.includes('`/`'))).toBe(true)
    })

    it('indents by two spaces only, never a tab', () => {
        for (const line of lines) {
            expect(line).not.toContain('\t')
            expect((/^ */.exec(line)?.[0].length ?? 0) % 2).toBe(0)
        }
    })

    it('has one open task, which the index reads as a task', () => {
        const tasks = deriveDoc(welcomePageBody(DEMO)).tasks
        expect(tasks).toHaveLength(1)
    })

    it("links to the user docs and to the demo of the Client that wrote it, and says the page can be deleted", () => {
        expect(welcomePageBody(DEMO)).toContain('(https://docs.etherpk.com/your-first-graph)')
        expect(welcomePageBody(DEMO)).toContain(`[The demo](${DEMO})`)
        expect(welcomePageBody(DEMO)).toMatch(/delete this page/i)
    })

    it("says how to reach today's journal, by the button's own label, on a desktop and on a phone", () => {
        const line = lines.find((text) => /journal entry/.test(text) && /\*\*Today\*\*/.test(text)) ?? ''
        expect(line).toMatch(/its tab/)
        expect(line).toMatch(/\*\*Today\*\* in the left sidebar/)
        expect(line).toMatch(/On a phone, tap the calendar icon in the top bar/)
        // Before the lines to try: it says where a person's own notes go.
        expect(lines.indexOf(line)).toBeLessThan(lines.indexOf('**Try these**'))
    })

    it('says how to delete it in words that are true on a phone too', () => {
        const line = lines.find((text) => /delete this page/i.test(text)) ?? ''
        expect(line).toMatch(/right-click its tab/)
        expect(line).toMatch(/long-press/)
    })

    it('carries no frontmatter: each store writes the title its own way', () => {
        expect(welcomePageBody(DEMO).startsWith('---')).toBe(false)
    })
})

describe("the demo's Welcome page", () => {
    it('holds the same lines to try, together and in order, so the two pages cannot drift apart', async () => {
        const demo = await readFile(resolve(__dirname, '../../../static/demo-graph/pages', `${WELCOME_PAGE_TITLE}.md`), 'utf8')
        expect(demo).toContain(`\n${WELCOME_TRY_LINES.join('\n')}\n`)
    })
})

/** A folder as nested objects: a string is a file, an object a folder. */
type Tree = { [name: string]: string | Tree }

function listing(tree: Tree, opened: string[] = [], path = ''): FolderListing {
    return {
        async *entries() {
            for (const [name, value] of Object.entries(tree)) {
                if (typeof value === 'string') yield { name, kind: 'file' as const }
                else {
                    yield {
                        name,
                        kind: 'directory' as const,
                        open: () => {
                            opened.push(`${path}${name}`)
                            return listing(value, opened, `${path}${name}/`)
                        },
                    }
                }
            }
        },
    }
}

const SKELETON: Tree = { journals: {}, pages: {}, assets: {}, etherpk: {} }
const noSettings = { exists: async () => false }

describe('a folder created empty', () => {
    it('is one with no Markdown anywhere in it and no settings file', async () => {
        expect(await isFolderCreatedEmpty(listing(SKELETON), noSettings)).toBe(true)
        expect(await isFolderCreatedEmpty(listing({}), noSettings)).toBe(true)
    })

    it('still counts with the agent instruction files in it, and files that are not Markdown', async () => {
        const tree: Tree = { ...SKELETON, assets: { 'garden.png': 'x' }, pages: { '.gitkeep': '' }, 'AGENTS.md': 'x', 'CLAUDE.md': 'x', 'notes.txt': 'x' }
        expect(await isFolderCreatedEmpty(listing(tree), noSettings)).toBe(true)
    })

    it('is not one that holds a page or a journal entry', async () => {
        expect(await isFolderCreatedEmpty(listing({ ...SKELETON, pages: { 'Garden.md': '- water the beans' } }), noSettings)).toBe(false)
        expect(await isFolderCreatedEmpty(listing({ ...SKELETON, journals: { '2026-03-04.md': '- water the beans' } }), noSettings)).toBe(false)
    })

    it('is not one with Markdown beside the four folders, whatever the case of its extension', async () => {
        expect(await isFolderCreatedEmpty(listing({ ...SKELETON, 'Kitchen.MD': 'x' }), noSettings)).toBe(false)
    })

    it('is not one with a note in a folder of its own, however deep: notes kept by another program', async () => {
        expect(await isFolderCreatedEmpty(listing({ Projects: { Garden: { Beds: { 'Beans.md': 'x' } } } }), noSettings)).toBe(false)
    })

    it('counts an instruction file as a note anywhere but directly in the folder', async () => {
        expect(await isFolderCreatedEmpty(listing({ Projects: { 'AGENTS.md': 'x' } }), noSettings)).toBe(false)
    })

    it('does not look inside dot-folders or node_modules', async () => {
        const opened: string[] = []
        const tree: Tree = { '.git': { 'notes.md': 'x' }, '.obsidian': { 'readme.md': 'x' }, node_modules: { pkg: { 'README.md': 'x' } }, Projects: {} }
        expect(await isFolderCreatedEmpty(listing(tree, opened), noSettings)).toBe(true)
        expect(opened).toEqual(['Projects'])
    })

    it('finds a note near the top before it walks a deep folder', async () => {
        const opened: string[] = []
        const tree: Tree = { Archive: { Old: { Older: {} } }, pages: { 'Garden.md': 'x' } }
        expect(await isFolderCreatedEmpty(listing(tree, opened), noSettings)).toBe(false)
        expect(opened).toEqual(['Archive', 'pages'])
    })

    it('is not one EtherPK has kept settings in: the folder was a graph before', async () => {
        const exists = vi.fn(async (subdir: string, name: string) => subdir === 'etherpk' && name === 'settings.json')
        expect(await isFolderCreatedEmpty(listing(SKELETON), { exists })).toBe(false)
    })

    it('is not one too large to finish looking through: without an answer, nothing is written', async () => {
        const many: Tree = {}
        for (let n = 0; n <= FOLDER_WALK_LIMIT; n++) many[`photo-${n}.jpg`] = 'x'
        expect(await isFolderCreatedEmpty(listing({ Pictures: many }), noSettings)).toBe(false)

        let deep: Tree = {}
        for (let n = 0; n < 40; n++) deep = { nested: deep }
        expect(await isFolderCreatedEmpty(listing(deep), noSettings)).toBe(false)
    })

    it('reads a folder that just fits', async () => {
        const some: Tree = {}
        for (let n = 0; n < 200; n++) some[`photo-${n}.jpg`] = 'x'
        expect(await isFolderCreatedEmpty(listing({ Pictures: some, a: { b: { c: {} } } }), noSettings)).toBe(true)
    })
})

describe('the claim a creation leaves for the first open', () => {
    it('is held for the graph it was left for, and no other', () => {
        const claims = createWelcomeClaims(memoryStorage())
        claims.leave('graph-a')
        expect(claims.take('graph-b')).toBe(false)
        expect(claims.take('graph-a')).toBe(true)
    })

    it('is taken once', () => {
        const claims = createWelcomeClaims(memoryStorage())
        claims.leave('graph-a')
        expect(claims.take('graph-a')).toBe(true)
        expect(claims.take('graph-a')).toBe(false)
    })

    it('is shared by every tab over the same storage, so two tabs cannot both take it', () => {
        const storage = memoryStorage()
        createWelcomeClaims(storage).leave('graph-a')
        expect(createWelcomeClaims(storage).take('graph-a')).toBe(true)
        expect(createWelcomeClaims(storage).take('graph-a')).toBe(false)
    })

    it('holds nothing without storage, or when storage refuses', () => {
        const none = createWelcomeClaims(null)
        none.leave('graph-a')
        expect(none.take('graph-a')).toBe(false)

        const refusing = createWelcomeClaims({
            getItem: () => {
                throw new Error('denied')
            },
            setItem: () => {
                throw new Error('denied')
            },
            removeItem: () => {
                throw new Error('denied')
            },
        })
        refusing.leave('graph-a')
        expect(refusing.take('graph-a')).toBe(false)
    })
})

describe('seeding the Welcome page on the first open', () => {
    function graph(options: { documents?: number; claims?: WelcomeClaims } = {}) {
        const claims = options.claims ?? createWelcomeClaims(memoryStorage())
        const pages = new Map<string, string>()
        const favourites: string[] = []
        const deps = {
            graphId: 'graph-a',
            demoUrl: DEMO,
            claims,
            documentCount: () => (options.documents ?? 0) + pages.size,
            createPage: vi.fn(async (title: string, body: string) => {
                if (pages.has(title)) throw new Error('exists')
                pages.set(title, body)
            }),
            addFavourite: vi.fn(async (title: string) => {
                favourites.push(title)
            }),
        }
        return { claims, pages, favourites, deps }
    }

    it('writes nothing for a graph nobody left a claim for: a second device, an import, a folder with notes', async () => {
        const { deps, pages, favourites } = graph()
        expect(await seedWelcomePage(deps)).toBe(false)
        expect(pages.size).toBe(0)
        expect(favourites).toEqual([])
    })

    it('writes the page and makes it a Favourite', async () => {
        const { deps, claims, pages, favourites } = graph()
        claims.leave('graph-a')
        expect(await seedWelcomePage(deps)).toBe(true)
        expect(pages.get(WELCOME_PAGE_TITLE)).toBe(welcomePageBody(DEMO))
        expect(favourites).toEqual([WELCOME_PAGE_TITLE])
    })

    it('writes it once: a second open, or the page deleted since, brings nothing back', async () => {
        const { deps, claims, pages } = graph()
        claims.leave('graph-a')
        await seedWelcomePage(deps)
        pages.clear()
        expect(await seedWelcomePage(deps)).toBe(false)
        expect(pages.size).toBe(0)
        expect(deps.createPage).toHaveBeenCalledTimes(1)
    })

    it('gives the claim up before it writes, so a write that fails is not tried again', async () => {
        const { deps, claims } = graph()
        claims.leave('graph-a')
        deps.createPage.mockRejectedValueOnce(new Error('disk full'))
        await expect(seedWelcomePage(deps)).rejects.toThrow('disk full')
        expect(await seedWelcomePage(deps)).toBe(false)
        expect(deps.createPage).toHaveBeenCalledTimes(1)
        expect(deps.addFavourite).not.toHaveBeenCalled()
    })

    it('writes nothing into a graph that holds a document by the time it opens, and gives the claim up', async () => {
        const { deps, claims, pages } = graph({ documents: 1 })
        claims.leave('graph-a')
        expect(await seedWelcomePage(deps)).toBe(false)
        expect(pages.size).toBe(0)
        expect(claims.take('graph-a')).toBe(false)
    })

    it('keeps the page when it cannot be made a Favourite', async () => {
        const { deps, claims, pages } = graph()
        claims.leave('graph-a')
        deps.addFavourite.mockRejectedValueOnce(new Error('read-only'))
        expect(await seedWelcomePage(deps)).toBe(true)
        expect(pages.has(WELCOME_PAGE_TITLE)).toBe(true)
    })
})
