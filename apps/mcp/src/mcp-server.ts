/**
 * The MCP face of the tools: names, descriptions and argument schemas an agent reads, mapped
 * onto `tools.ts`. Nothing is decided here. A {@link ToolError} becomes an `isError` result
 * carrying its code and sentence, so the agent can act on the refusal instead of retrying it.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { HeadlessGraph } from './headless-graph'
import { createPublication, listPublications, publish, publishingInfo, updatePublication } from './publish-tools'
import { createTheme, customisePublicationTheme, deleteTheme, deleteThemeFile, importThemeFolder, listThemes, previewTheme, readTheme, readThemeFile, writeThemeFile } from './theme-tools'
import {
    LIST_PAGE_LIMIT,
    SEARCH_PAGE_LIMIT,
    READ_MANY_LIMIT,
    TASK_PAGE_LIMIT,
    ToolError,
    appendDocument,
    backlinks,
    createPage,
    editDocument,
    graphInfo,
    listAssets,
    listDocuments,
    planRename,
    readAsset,
    readDocument,
    readDocuments,
    rename,
    search,
    setAliases,
    setFrontmatter,
    setTask,
    tasks,
    uploadAsset,
} from './tools'

export interface McpServerInfo {
    graphName: string
    version: string
    /** How this CLI is spelled for the user in a refusal that names a command; `etherpk-mcp` by default. */
    cmd?: string
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function ok(value: unknown): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function failed(error: unknown): ToolResult {
    const body =
        error instanceof ToolError
            ? { error: error.code, message: error.message }
            : { error: 'internal', message: error instanceof Error ? error.message : String(error) }
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true }
}

async function runTool(work: () => Promise<unknown> | unknown): Promise<ToolResult> {
    try {
        return ok(await work())
    } catch (error) {
        return failed(error)
    }
}

/**
 * The refusal every tool gives once the Sync Server has ended access, instead of answering from
 * a cache that can no longer be trusted or saved.
 */
export function accessEndedError(graph: Pick<HeadlessGraph, 'accessLoss'>, cmd: string): ToolError | null {
    const loss = graph.accessLoss()
    if (!loss) return null
    return loss.kind === 'membership'
        ? new ToolError('access_removed', `This account no longer has access to the graph: it left, was removed by the owner, or the graph was deleted. Run ${cmd} graphs to see the graphs it can reach.`)
        : new ToolError('token_revoked', `The Sync Server no longer accepts this computer's access token: it was revoked or has expired, or the account's password was reset. Run ${cmd} login again.`)
}

const concept = z.string().min(1).describe('A page title, one of its aliases, a journal day as YYYY-MM-DD, or "today".')
const offset = z.number().int().nonnegative().optional().describe('Skip this many results (paging).')
/** A frontmatter value as JSON carries it; the writer turns it into YAML. */
const frontmatterValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())])

export function createMcpServer(graph: HeadlessGraph, info: McpServerInfo): McpServer {
    // Every tool goes through this: once access has ended, it refuses before touching the graph.
    const run = (work: () => Promise<unknown> | unknown): Promise<ToolResult> =>
        runTool(() => {
            const ended = accessEndedError(graph, info.cmd ?? 'etherpk-mcp')
            if (ended) throw ended
            return work()
        })
    const server = new McpServer(
        { name: 'etherpk', version: info.version },
        {
            instructions: [
                `You are connected to the EtherPK knowledge graph "${info.graphName}": daily journal entries and titled pages in plain markdown, linked with [[wikilinks]].`,
                'Concept names are case-insensitive. A protected document is listed with protected: true and cannot be read or written here; tell the user to unlock it in EtherPK if a task needs it.',
                'Bullets are "- " with two-space nesting; tasks are "- [ ]" / "- [x]" with task tags (#P1 #P2 #P3, #W #D #C, #D-YYYY-MM-DD due, #S-YYYY-MM-DD scheduled) right after the checkbox.',
                'read_document returns a document\'s body as text and its frontmatter block as data (the "frontmatter" object); the block is never in the text, so line numbers from search, backlinks and tasks match the text. Set frontmatter keys with set_frontmatter (public, publications, date, author, description and any other key); a document\'s title and aliases and a publication page\'s definition are not frontmatter here and have tools of their own.',
                'Edit with edit_document (an exact, unique old→new replacement) or append_document; read first, then edit, and never paste a whole page back.',
                'To rename a page or concept use plan_rename then rename, never a frontmatter edit: rename carries scoped concepts ("[[Old]] Notes") along and by default rewrites every [[Old]] link in the graph to the new name (strategy "rewrite"); strategy "alias" keeps the old name resolving instead. A rename onto a name that is taken merges two documents and needs confirm_merge: true. References inside protected documents cannot be seen or rewritten.',
                'search has two kinds of matching: mode "text" (default) matches words and quoted phrases; mode "semantic" finds passages about what a question or description means even when no words match. Use semantic for questions and descriptions, text for names, identifiers and exact phrases; "hybrid" returns both groups. When you answer from a search result, cite the document and where in it (its breadcrumb or lines). Semantic mode needs a one-time "semantic setup" on this computer; if it is not set up, search says so and names the command.',
                'Start with graph_info to see what you are connected to. read_documents reads several documents in one call; tasks lists tasks and set_task changes one (status, priority, due and scheduled dates) by document and line.',
                'Publishing: list_publications shows the publications this graph defines (a publication is a page whose frontmatter defines it; its outline is the site navigation) and the public documents none takes; a document is on a site when its frontmatter has public: true and names the publication in publications. create_publication and update_publication change the settings; publish writes the site into the publish folder the user set for it on this machine with the etherpk-mcp publish command (the tool cannot choose a folder) and returns the report. Diagrams need a browser the user installs once with "diagrams setup".',
                "Themes: a publication's look is a theme - Mustache templates, a stylesheet, a script and a manifest. list_themes shows the bundled ones (read-only) and the graph's own; read_theme writes a theme's files to a folder on this machine to read and edit; customise_publication_theme copies a publication's bundled theme into the graph and points the publication at the copy (create_theme copies any theme); write_theme_file, delete_theme_file and import_theme_folder change a graph theme; preview_theme renders a theme to a folder (with screenshots when a browser is set up) to check before publish. For a snippet such as an analytics script, an include slot (update_publication includes, e.g. head) filled by a page may be lighter than a theme copy.",
                'Images and files are assets: upload_asset adds a file from this machine and returns the markdown to paste into a document; read_asset writes an asset to a local file you can open; list_assets shows the assets documents reference. An asset is available only where a document you can read references it (or you uploaded it this session). read_asset, read_theme and preview_theme write under the graph\'s downloads directory and return the path; name a folder relative to it, never elsewhere.',
                'The user documentation is at https://docs.etherpk.com.',
            ].join('\n'),
        },
    )

    server.registerTool(
        'list_documents',
        {
            title: 'List documents',
            description: `Every page and journal entry in the graph with its aliases; protected documents carry protected: true and have no readable body. from / to narrow to the journal entries of a range of days. Paged, at most ${LIST_PAGE_LIMIT} per call.`,
            inputSchema: {
                kind: z.enum(['page', 'journal']).optional().describe('Only pages, or only journal entries.'),
                from: z.string().optional().describe('Journal entries on or after this day (YYYY-MM-DD); implies kind journal.'),
                to: z.string().optional().describe('Journal entries on or before this day (YYYY-MM-DD); implies kind journal.'),
                offset,
                limit: z.number().int().positive().max(LIST_PAGE_LIMIT).optional(),
            },
        },
        async (args) => run(() => listDocuments(graph, args)),
    )

    server.registerTool(
        'read_document',
        {
            title: 'Read a document',
            description: 'One document: its body as "text" (the markdown after any frontmatter block) and its frontmatter as the "frontmatter" object, minus title and aliases (its identity) and any publication definition. Refuses a protected document with error "protected_document". Long documents are cut and marked truncated: true.',
            inputSchema: { concept },
        },
        async (args) => run(() => readDocument(graph, args.concept)),
    )

    server.registerTool(
        'read_documents',
        {
            title: 'Read several documents',
            description: `Up to ${READ_MANY_LIMIT} documents in one call, each as read_document returns it. A protected or unknown document is reported in its place with an error code rather than failing the call. Long texts are cut and marked truncated.`,
            inputSchema: { concepts: z.array(concept).min(1).max(READ_MANY_LIMIT) },
        },
        async (args) => run(() => readDocuments(graph, args)),
    )

    server.registerTool(
        'search',
        {
            title: 'Search',
            description: `Search every unprotected document. mode "text" (default): words match by prefix, "quoted phrases" match exactly; documents come most-matches-first with the matching lines. mode "semantic": the passages closest in MEANING to the query, best first, each with its text, a similarity 0..1 and where it is (concept, breadcrumb of headings and parent bullets, start and end line) - finds a note that says "self-assessment is due 31 January" for "tax deadline". Line numbers are 0-based in every mode. Passage text is the note's own words with bullet markers and [[ ]] stripped: quote and cite it, but anchor edit_document on text from read_document. Use semantic for questions and descriptions, text for names, identifiers and exact phrases; mode "hybrid" returns both as separate groups. Semantic results carry complete: false while this computer is still embedding the graph (rerun later for more). If semantic mode answers error semantic_unavailable, it is not set up on this computer: tell the user the command in the message. At most ${SEARCH_PAGE_LIMIT} documents per call.`,
            inputSchema: {
                query: z.string().min(1),
                mode: z.enum(['text', 'semantic', 'hybrid']).optional().describe('text (default), semantic, or hybrid.'),
                offset,
                limit: z.number().int().positive().max(SEARCH_PAGE_LIMIT).optional(),
            },
        },
        async (args) => run(() => search(graph, args)),
    )

    server.registerTool(
        'backlinks',
        {
            title: 'Backlinks',
            description:
                'Every document that links to a concept with [[Concept]], with the linking block or paragraph, and every document scoped by it (a title such as "[[Concept]] Notes" is a reference of kind "title"). Aliases are pooled: linking an alias counts.',
            inputSchema: { concept },
        },
        async (args) => run(() => backlinks(graph, args.concept)),
    )

    server.registerTool(
        'tasks',
        {
            title: 'Tasks',
            description: `Tasks ("- [ ]" bullets) across the graph with their tags. Defaults to every unfinished task. A concept filter matches tasks written on that page, linking it, or nested under a block or heading that links it. At most ${TASK_PAGE_LIMIT} per call.`,
            inputSchema: {
                concept: concept.optional(),
                statuses: z.array(z.enum(['open', 'doing', 'waiting', 'done', 'cancelled'])).optional(),
                priorities: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('none')])).optional(),
                due: z.enum(['any', 'overdue', 'today', 'next7']).optional(),
                offset,
                limit: z.number().int().positive().max(TASK_PAGE_LIMIT).optional(),
            },
        },
        async (args) => run(() => tasks(graph, args)),
    )

    server.registerTool(
        'set_task',
        {
            title: 'Set a task',
            description: 'Change one task by document and 0-based line (as tasks and read_document count lines): its status (open, doing, waiting, done, cancelled - exclusive), priority (1, 2, 3 or null), due and scheduled days (YYYY-MM-DD or null). Pass expect with the task\'s text from tasks; if the line no longer holds that task the change is refused with error "task_moved" and nothing is edited.',
            inputSchema: {
                concept,
                line: z.number().int().nonnegative(),
                changes: z.object({
                    status: z.enum(['open', 'doing', 'waiting', 'done', 'cancelled']).optional(),
                    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]).optional(),
                    due: z.string().nullable().optional(),
                    scheduled: z.string().nullable().optional(),
                }),
                expect: z.string().optional().describe('The task text as tasks returned it.'),
            },
        },
        async (args) => run(() => setTask(graph, args)),
    )

    server.registerTool(
        'edit_document',
        {
            title: 'Edit a document',
            description: 'Replace one exact occurrence of "old" with "new" in a document. "old" must appear exactly once (include surrounding lines to disambiguate); the change is applied as one edit, so on a synced graph it merges with anyone typing elsewhere in the page, and on a folder it is in the file when this returns. Refused on a protected document.',
            inputSchema: {
                concept,
                old: z.string().min(1).describe('The exact text to replace, as read_document returned it.'),
                new: z.string().describe('The replacement text. Empty deletes the old text.'),
            },
        },
        async (args) => run(() => editDocument(graph, args)),
    )

    server.registerTool(
        'append_document',
        {
            title: 'Append to a document',
            description: 'Add text at the end of a page or a journal entry, on a new line. A journal day that has no entry yet is created ("today" is accepted). A page that does not exist is not created: use create_page.',
            inputSchema: {
                concept,
                text: z.string().min(1),
            },
        },
        async (args) => run(() => appendDocument(graph, args)),
    )

    server.registerTool(
        'create_page',
        {
            title: 'Create a page',
            description: 'Create a new page with the given title, optional markdown body and optional frontmatter (the same keys and rules as set_frontmatter). Refuses a title that already names a page or an alias, or that is a calendar day (use append_document for journal entries).',
            inputSchema: {
                title: z.string().min(1),
                text: z.string().optional(),
                frontmatter: z.record(z.string(), frontmatterValue).optional().describe('Frontmatter keys for the new page, e.g. {"public": true, "publications": ["blog"], "date": "2026-01-31"}.'),
            },
        },
        async (args) => run(() => createPage(graph, args)),
    )

    server.registerTool(
        'plan_rename',
        {
            title: 'Plan a rename',
            description: 'What renaming a page or concept would do, before anything changes: the scoped concepts carried along (cascade), the documents whose links would be rewritten (referencingDocuments, by name - read or backlinks any of them), any merge (the new name is already a document\'s name or alias, so the two would be joined), a refusal if the rename is not allowed, and how many protected documents exist whose references cannot be seen. Journal entries cannot be renamed.',
            inputSchema: {
                from: z.string().min(1).describe('The current name: a page title or a concept that only links name.'),
                to: z.string().min(1).describe('The new name.'),
            },
        },
        async (args) => run(() => planRename(graph, args)),
    )

    server.registerTool(
        'rename',
        {
            title: 'Rename',
            description: 'Rename a page or concept. Its page (if any) and every scoped concept beneath it ("[[Old]] Notes" becomes "[[New]] Notes") move with it. strategy "rewrite" (default) rewrites every [[Old]] link in the graph to the new name; "alias" keeps the old name as an alias so existing links keep resolving. If the new name is already taken the two documents would merge, which is irreversible: refused with error "merge_requires_confirmation" unless confirm_merge is true. Refused with "unconfirmed_documents" if a document it must read has not finished syncing to this device (nothing changes; try again). Call plan_rename first to see what will happen.',
            inputSchema: {
                from: z.string().min(1),
                to: z.string().min(1),
                strategy: z.enum(['rewrite', 'alias']).optional().describe('rewrite (default) or alias.'),
                confirm_merge: z.boolean().optional().describe('Allow the rename to merge into an existing document.'),
            },
        },
        async (args) => run(() => rename(graph, args)),
    )

    server.registerTool(
        'set_aliases',
        {
            title: 'Set aliases',
            description: 'Replace a document\'s aliases: other names it answers to in [[wikilinks]], Quick Find and on a published site. The list you pass is the complete list. A name that is already another document\'s title or alias is refused with error "name_taken".',
            inputSchema: {
                concept,
                aliases: z.array(z.string()).describe('Every alias the document should have; an empty list removes them all.'),
            },
        },
        async (args) => run(() => setAliases(graph, args)),
    )

    server.registerTool(
        'set_frontmatter',
        {
            title: 'Set frontmatter',
            description: 'Set keys of a document\'s frontmatter block, adding the block if there is none. A merge patch: the keys you name are set, null removes a key, every other key keeps its value. "public" (true/false) and "publications" (a list of publication ids: lower-case letters, digits and hyphens) decide what is published, and are validated. Refuses "title", "aliases" and "publication" with error "identity_key" (use rename, set_aliases and the publication tools), and a protected document. Returns the resulting frontmatter.',
            inputSchema: {
                concept,
                patch: z.record(z.string(), frontmatterValue).describe('Keys to set; null removes a key. Example: {"public": true, "publications": ["blog"], "date": "2026-01-31", "draft": null}.'),
            },
        },
        async (args) => run(() => setFrontmatter(graph, args)),
    )

    server.registerTool(
        'upload_asset',
        {
            title: 'Upload an asset',
            description: 'Add a file on this machine (an image, a PDF, any file) to the graph as an asset. Returns the reference and the markdown to paste into a document (an image tag for an image, a link otherwise). Bytes the graph already holds are not stored twice: the result then says reused: true and points at the existing asset. The file is stored as it is, without image optimisation. Refused with error "invalid_argument" for a folder, a file over 100 MiB, a hidden file or one in a hidden folder (.ssh, .env), and the Headless Client\'s own config and cache; with error "asset_refused" when the server declines it on a quota.',
            inputSchema: {
                path: z.string().min(1).describe('Absolute path of an ordinary file on this machine.'),
                name: z.string().min(1).optional().describe('The name to store it under; the file\'s own name by default.'),
            },
        },
        async (args) => run(() => uploadAsset(graph, args)),
    )

    server.registerTool(
        'read_asset',
        {
            title: 'Read an asset',
            description: 'Write an asset\'s bytes to a file on this machine and return the path, so you can open or view it. Pass the reference as a document shows it ("../assets/<name>") or the name alone. Available only where a document you can read references the asset (or you uploaded it this session); otherwise error "asset_not_found". The file is written under the graph\'s downloads directory, named after the asset, and never over an existing file.',
            inputSchema: {
                ref: z.string().min(1),
                out_dir: z.string().min(1).optional().describe('A folder under the graph\'s downloads directory, relative to it; the downloads directory itself by default. A folder outside it is refused.'),
            },
        },
        async (args) => run(() => readAsset(graph, args)),
    )

    server.registerTool(
        'list_assets',
        {
            title: 'List assets',
            description: 'The assets referenced from documents you can read - every one, or those one document references - each with its reference, name, type, size where known, and the documents that reference it. Orphaned assets and those referenced only from protected documents are not listed.',
            inputSchema: {
                concept: concept.optional(),
            },
        },
        async (args) => run(() => listAssets(graph, args)),
    )

    const host = { env: process.env, cmd: info.cmd }

    server.registerTool(
        'list_publications',
        {
            title: 'List publications',
            description: 'The publications this graph defines - id, name, the page that defines each, kind (docs or blog), selection (named: documents that list it in publications; all-public: every public document), home, url, theme, include slots, and the publish folder set for it on this machine (null when none) - with any issues in their pages and the public documents no publication takes.',
            inputSchema: {},
        },
        async () => run(() => listPublications(graph, host)),
    )

    server.registerTool(
        'create_publication',
        {
            title: 'Create a publication',
            description: 'Create a publication: a page titled with its name whose frontmatter defines it and whose outline (bullets of [[wikilinks]]) is the site navigation. id defaults to a slug of the title; kind is docs (default) or blog; selection is named (default: a document joins by listing the id in its publications) or all-public. theme is a bundled theme name (etherpk-docs, etherpk-blog), a theme in the graph, or a url.',
            inputSchema: {
                title: z.string().min(1),
                id: z.string().min(1).optional(),
                kind: z.enum(['docs', 'blog']).optional(),
                selection: z.enum(['named', 'all-public']).optional(),
                home: z.string().min(1).optional().describe('The page whose content is the front page; absent, an index is generated.'),
                url: z.string().min(1).optional().describe('Where the site will be deployed, for its feed and sitemap.'),
                theme: z.string().min(1).optional(),
            },
        },
        async (args) => run(() => createPublication(graph, args, host)),
    )

    server.registerTool(
        'update_publication',
        {
            title: 'Update a publication',
            description: 'Change a publication\'s settings on its page. Each change is optional; null removes a field (back to its default) or clears an include slot. includes maps a theme\'s slot name (head, logo, header, footer, before, after, scripts, styles, or one the theme adds) to the page that fills it; that page must be public and in the publication.',
            inputSchema: {
                id: z.string().min(1),
                changes: z.object({
                    kind: z.enum(['docs', 'blog']).nullable().optional(),
                    selection: z.enum(['named', 'all-public']).nullable().optional(),
                    home: z.string().nullable().optional(),
                    url: z.string().nullable().optional(),
                    theme: z.string().nullable().optional(),
                    recent: z.number().int().nonnegative().nullable().optional().describe('Posts on a blog\'s front page; null for the default (10).'),
                    includes: z.record(z.string(), z.string().nullable()).optional(),
                }),
            },
        },
        async (args) => run(() => updatePublication(graph, args, host)),
    )

    server.registerTool(
        'publish',
        {
            title: 'Publish',
            description: 'Render a publication to its publish folder on this machine and return the report: what was included and why documents were left out, missing links, assets, warnings. The folder is the one the user set with "etherpk-mcp publish --publication <id> --out <dir>" (error "no_publish_folder" until then; the tool never chooses a folder). Pages with Mermaid diagrams need the browser from "diagrams setup" (error "chromium_unavailable"). The report is this result, trimmed to counts and first entries; nothing of it is written into the folder, so the site never names the documents it leaves out. Publishing writes files; it does not deploy them.',
            inputSchema: { id: z.string().min(1) },
        },
        async (args) => run(() => publish(graph, args, host)),
    )

    server.registerTool(
        'list_themes',
        {
            title: 'List themes',
            description: "Every theme a publication here can use: the bundled ones (etherpk-docs, etherpk-blog; read-only, with their files and manifest) and the graph's own (editable; id, name, origin, files, manifest, validation errors, and which publications use each).",
            inputSchema: {},
        },
        async () => run(() => listThemes(graph)),
    )

    server.registerTool(
        'read_theme',
        {
            title: 'Read a theme',
            description: "Write a theme's files (theme.json, layouts/, partials/, assets/) to a folder on this machine and return the path and file list, so you can read and edit them with your own tools. ref is a graph theme id, a bundled theme name or a url. Editing the folder changes nothing until write_theme_file or import_theme_folder brings it back; a bundled or url theme cannot be edited in place at all (create_theme copies it).",
            inputSchema: {
                ref: z.string().min(1),
                out_dir: z.string().min(1).optional().describe("A folder under the graph's downloads directory, relative to it; themes/<ref> there by default. A folder outside it is refused."),
            },
        },
        async (args) => run(() => readTheme(graph, args)),
    )

    server.registerTool(
        'read_theme_file',
        {
            title: 'Read a theme file',
            description: 'One file of a theme, as text: theme.json, or a path under layouts/, partials/ or assets/.',
            inputSchema: { ref: z.string().min(1), path: z.string().min(1) },
        },
        async (args) => run(() => readThemeFile(graph, args)),
    )

    server.registerTool(
        'create_theme',
        {
            title: 'Create a theme',
            description: 'Copy a theme into the graph as one of its own, ready to edit: from a bundled theme name, a url, or another theme in the graph. Returns the new theme; point a publication at it with update_publication (theme: <id>).',
            inputSchema: {
                from: z.string().min(1),
                id: z.string().min(1).optional().describe('Lower-case letters, digits and hyphens; from the source by default.'),
                name: z.string().min(1).optional(),
            },
        },
        async (args) => run(() => createTheme(graph, args)),
    )

    server.registerTool(
        'customise_publication_theme',
        {
            title: "Customise a publication's theme",
            description: "Make a publication's theme editable: if it uses a bundled or url theme, copy that theme into the graph and point the publication at the copy; if it already uses a graph theme, return it. The step before editing the look of a published site.",
            inputSchema: {
                publication: z.string().min(1).describe('The publication id.'),
                id: z.string().min(1).optional().describe('The id for the copy; <publication>-theme by default.'),
                name: z.string().min(1).optional(),
            },
        },
        async (args) => run(() => customisePublicationTheme(graph, args)),
    )

    server.registerTool(
        'write_theme_file',
        {
            title: 'Write a theme file',
            description: 'Set one file of a graph theme (creating it if new): theme.json, or a path under layouts/, partials/ or assets/. The theme is validated afterwards and any problem returned as errors, so a broken manifest or a missing layouts/page.html is reported on the write, not on the next publish. Refused for a bundled theme with error "theme_not_editable".',
            inputSchema: { id: z.string().min(1), path: z.string().min(1), text: z.string() },
        },
        async (args) => run(() => writeThemeFile(graph, args)),
    )

    server.registerTool(
        'delete_theme_file',
        {
            title: 'Delete a theme file',
            description: 'Remove one file from a graph theme; the theme is validated afterwards and problems returned as errors.',
            inputSchema: { id: z.string().min(1), path: z.string().min(1) },
        },
        async (args) => run(() => deleteThemeFile(graph, args)),
    )

    server.registerTool(
        'import_theme_folder',
        {
            title: 'Import a theme folder',
            description: "Replace a graph theme's files with a folder's contents - the way back after editing what read_theme wrote. Files the folder no longer has are removed from the theme; the folder needs a theme.json at its top. dir is the folder read_theme returned, or another under the graph's downloads directory; a folder outside it is refused, and symbolic links in it are skipped. Validated afterwards.",
            inputSchema: { id: z.string().min(1), dir: z.string().min(1) },
        },
        async (args) => run(() => importThemeFolder(graph, args)),
    )

    server.registerTool(
        'delete_theme',
        {
            title: 'Delete a theme',
            description: "Remove a graph theme. Refused with error \"theme_in_use\" while a publication's saved settings name it; point the publication at another theme first.",
            inputSchema: { id: z.string().min(1) },
        },
        async (args) => run(() => deleteTheme(graph, args)),
    )

    server.registerTool(
        'preview_theme',
        {
            title: 'Preview a theme',
            description: "Render a theme to a folder on this machine and return where: a publication's real pages when a publication is given (with its own theme, or the theme named), or a sample site covering every construct when only a theme is given. Open the HTML to check markup and styles. With screenshots: true and a browser set up (diagrams setup or ETHERPK_CHROMIUM), the front page and one content page are photographed at desktop and phone widths as PNGs you can view. A preview is scratch, not the publish folder. The page loads nothing from the network while it is photographed. out_dir is a folder under the graph's downloads directory (previews/<name> there by default); a folder outside it is refused.",
            inputSchema: {
                theme: z.string().min(1).optional(),
                publication: z.string().min(1).optional(),
                out_dir: z.string().min(1).optional(),
                screenshots: z.boolean().optional(),
            },
        },
        async (args) => run(() => previewTheme(graph, args, host)),
    )

    server.registerTool(
        'graph_info',
        {
            title: 'Graph info',
            description: 'What you are connected to: the graph\'s name, whether it is a synced graph (and on which server) or a folder, how many pages and journal entries it has and how many are protected, the state of semantic search, whether assets are available, the publications with the publish folder set for each on this machine, and whether Mermaid diagrams can be drawn here.',
            inputSchema: {},
        },
        async () => run(async () => ({ ...(await graphInfo(graph)), publishing: await publishingInfo(graph, host) })),
    )

    return server
}
