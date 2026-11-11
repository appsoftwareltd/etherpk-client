/**
 * The Welcome page a graph created empty starts with (ADR 0183).
 *
 * A new synced graph, and a folder opened as a Local Graph that holds no notes, get one real page,
 * "Welcome to EtherPK": a few lines a person can try where they stand. It is an ordinary page.
 * Deleting it is how a person says they do not want it, so it is written once and never again.
 *
 * Three parts, all framework-free:
 *
 * - the text ({@link welcomePageBody}), whose lines to try are also in the Demo Graph's own
 *   Welcome page (`static/demo-graph/pages/Welcome to EtherPK.md`). A unit test fails when the two
 *   differ.
 * - what counts as a folder created empty ({@link isFolderCreatedEmpty}).
 * - the claim ({@link WelcomeClaims}). The Graphs page leaves one when it creates a graph, and the
 *   first open of that graph takes it and writes the page through the graph's own document store,
 *   so a synced graph's copy is encrypted and synced like any page. Nothing else leaves a claim:
 *   an import, another device, a Member joining and the Demo Graph never write the page.
 */
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'

/** The page's name. The Demo Graph's own Welcome page has the same one. */
export const WELCOME_PAGE_TITLE = 'Welcome to EtherPK'

/**
 * The lines a person can try, in the document format a Graph Folder holds: `- ` bullets nested by
 * two spaces, a `[[wikilink]]`, a `- [ ]` task. The link names a page that no new graph has, so
 * following it shows a Draft. The Demo Graph's Welcome page carries these lines word for word.
 */
export const WELCOME_TRY_LINES: readonly string[] = [
    '- Press Enter at the end of a bullet to start the next one.',
    '  - Press Tab to nest a bullet under the one above, and Shift+Tab to bring it back out.',
    '- Click [[Reading List]]. There is no page for it yet, so you get a draft. It becomes a page when you type in it.',
    '- [ ] Tick this task. The **Tasks** view lists every task in the graph.',
    '- Type `/` on an empty line for the command menu: tables, dates, images and more.',
]

const INTRODUCTION = 'This page is for trying things. Your own notes go in the journal entry for today, or on pages you name.'

/**
 * How to reach today's journal, which is open in the tab to the right of this page. **Today** is
 * the label of the Graph Sidebar's button, and a phone has the same Command on its top bar.
 */
const TODAYS_JOURNAL =
    "To open today's journal entry, select its tab, or select **Today** in the left sidebar. On a phone, tap the calendar icon in the top bar."

/** The lines after the ones to try. The demo is the one this Client serves, at `demoUrl`. */
function whereNext(demoUrl: string): string[] {
    return [
        '- [Your First Graph](https://docs.etherpk.com/your-first-graph) is the tutorial in the user docs.',
        `- [The demo](${demoUrl}) is a graph full of notes.`,
        '- To delete this page, right-click its tab, or on a phone long-press its name in the top bar, and select **Delete…**. It does not come back.',
    ]
}

/**
 * The page's text, without frontmatter: a Filesystem Backend writes the title into a frontmatter
 * block of its own, and a Server Backend keeps it in the graph's registry.
 *
 * `demoUrl` is the address of the Demo Graph on the Client that writes the page, so a self-hosted
 * Client links to its own demo. It is written in full, since the page is also read where a
 * relative address means nothing: a text editor, a published site.
 */
export function welcomePageBody(demoUrl: string): string {
    return [INTRODUCTION, '', TODAYS_JOURNAL, '', '**Try these**', '', ...WELCOME_TRY_LINES, '', ...whereNext(demoUrl), ''].join('\n')
}

/** The agent instruction files EtherPK and the Agent Skill write into a Graph Folder (ADR 0070). */
const INSTRUCTION_FILES = new Set(['agents.md', 'claude.md'])

function isMarkdown(name: string): boolean {
    return name.toLowerCase().endsWith('.md')
}

/** A folder to look through: the web File System API's directory handle, reduced to what the walk needs. */
export interface FolderListing {
    entries(): AsyncIterable<FolderChild>
}

export type FolderChild = { name: string; kind: 'file' } | { name: string; kind: 'directory'; open(): FolderListing }

/** How many files and folders the walk looks at before it gives up. */
export const FOLDER_WALK_LIMIT = 5000

/** How many folders deep the walk goes before it gives up. */
const FOLDER_WALK_DEPTH = 16

/** Folders that hold a program's own files, never a person's notes. */
function isSkippedFolder(name: string): boolean {
    return name.startsWith('.') || name === 'node_modules'
}

/** A Markdown file is a note, except the agent instruction files directly in the graph folder. */
function isNote(entry: FolderChild, depth: number): boolean {
    if (entry.kind !== 'file' || !isMarkdown(entry.name)) return false
    return depth > 0 || !INSTRUCTION_FILES.has(entry.name.toLowerCase())
}

/**
 * Whether the folder holds a Markdown file anywhere, apart from the agent instruction files
 * directly in it. Folder by folder from the top, so a note in `pages` is found before a deep
 * archive is walked, and it stops at the first note. `null` when the folder is too large or too
 * deep to finish.
 */
async function holdsNote(root: FolderListing): Promise<boolean | null> {
    let seen = 0
    // A folder is opened when its turn comes, so a note found first costs no further reads.
    const queue: Array<{ open: () => FolderListing; depth: number }> = [{ open: () => root, depth: 0 }]
    for (let next = queue.shift(); next; next = queue.shift()) {
        const { depth } = next
        if (depth > FOLDER_WALK_DEPTH) return null
        for await (const entry of next.open().entries()) {
            if (++seen > FOLDER_WALK_LIMIT) return null
            if (isNote(entry, depth)) return true
            if (entry.kind === 'directory' && !isSkippedFolder(entry.name)) queue.push({ open: () => entry.open(), depth: depth + 1 })
        }
    }
    return false
}

/**
 * Whether a folder about to become a Local Graph was created empty: no Markdown file anywhere
 * under it, apart from `AGENTS.md` and `CLAUDE.md` directly in it, and no `etherpk/settings.json`.
 * Notes another program keeps in folders of its own count, so the page is never written into a
 * folder that already has notes. Dot-folders and `node_modules` are not looked into. A folder the
 * walk cannot finish is not empty: without an answer, nothing is written.
 *
 * The settings file says EtherPK has had the folder as a graph before. The Welcome page's own
 * Favourite writes one, so a person who deletes the page, removes the graph from the list and
 * opens the folder again is not given the page a second time.
 */
export async function isFolderCreatedEmpty(folder: FolderListing, adapter: Pick<DirectoryAdapter, 'exists'>): Promise<boolean> {
    if (await adapter.exists('etherpk', 'settings.json')) return false
    return (await holdsNote(folder)) === false
}

/** The part of `Storage` a claim needs. */
export type ClaimStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * The note a creation leaves for the first open of the graph it made: "this graph was created
 * empty, here, and has not had its Welcome page yet".
 */
export interface WelcomeClaims {
    /** Called by the two creation paths, once the graph is in the registry. */
    leave(graphId: string): void
    /** Whether a claim was held for `graphId`. It is gone when this returns, whatever the answer. */
    take(graphId: string): boolean
}

const CLAIM_KEY_PREFIX = 'etherpk-welcome-pending:'

/**
 * Claims kept in `localStorage`, one key for each graph: on this device only, and read and removed
 * in one synchronous step, so two tabs opening the graph together cannot both take it. Storage
 * that is missing or refuses holds no claim, and that graph opens without a Welcome page.
 */
export function createWelcomeClaims(storage: ClaimStorage | null): WelcomeClaims {
    return {
        leave(graphId) {
            try {
                storage?.setItem(CLAIM_KEY_PREFIX + graphId, '1')
            } catch {
                /* no claim: the graph opens without the page, which is only a convenience */
            }
        },
        take(graphId) {
            try {
                const key = CLAIM_KEY_PREFIX + graphId
                if (!storage || storage.getItem(key) === null) return false
                storage.removeItem(key)
                return true
            } catch {
                return false
            }
        },
    }
}

/** This browser's claims. `localStorage` throws on access in some private modes. */
export function browserWelcomeClaims(): WelcomeClaims {
    try {
        return createWelcomeClaims(typeof localStorage === 'undefined' ? null : localStorage)
    } catch {
        return createWelcomeClaims(null)
    }
}

export interface SeedWelcomePageDeps {
    graphId: string
    /** Where this Client serves the Demo Graph, as a whole address. */
    demoUrl: string
    claims: WelcomeClaims
    /** How many documents the open graph holds, pages and journal entries. */
    documentCount: () => number
    /** The open store's `createPage`. */
    createPage: (title: string, body: string) => Promise<unknown>
    addFavourite: (title: string) => Promise<void>
}

/**
 * Write the Welcome page into the graph being opened, when its creation left a claim. Answers
 * whether the page was written, so the caller can open the graph on it.
 *
 * At most once for a graph: the claim is given up before anything is written, so a write that
 * fails, or a tab closed part-way, leaves a graph without the page and never one that is written
 * to again on a later open. A graph that already holds a document by now is left as it is.
 */
export async function seedWelcomePage(deps: SeedWelcomePageDeps): Promise<boolean> {
    if (!deps.claims.take(deps.graphId)) return false
    if (deps.documentCount() > 0) return false
    await deps.createPage(WELCOME_PAGE_TITLE, welcomePageBody(deps.demoUrl))
    try {
        await deps.addFavourite(WELCOME_PAGE_TITLE)
    } catch (error) {
        // The page is written and can be made a Favourite by hand; the open carries on.
        console.warn('[welcome] could not add the Welcome page to Favourites', error)
    }
    return true
}
