/**
 * The publishing tools (ADR 0082, 0084, 0086; [[2026-09-20 Headless Client Assets Rename And
 * Publishing]]): what the Client's Publish tab does, as plain functions over a
 * {@link HeadlessGraph}, beside `tools.ts` and under its rules. Thin over `publish-service.ts`,
 * which the Settings tab uses too, so a publication page an agent creates is the one a person
 * would have created.
 *
 * Two things are this host's own. The [[Publish Folder]] is configuration a person set on the
 * command line, never a tool argument: the site writer deletes strays from the paths it owns,
 * and a folder an agent inferred could lose real files to that rule. And a publish whose pages
 * hold Mermaid needs the browser `diagrams setup` installed; without one it refuses rather than
 * publishing a site with its diagrams turned to text.
 */

import { selectDocuments } from '$lib/document/publish/selection'
import { isPublicationId } from '$lib/document/publish/publication'
import type { Publication } from '$lib/document/publish/types'
import { writeSite } from '$lib/document/publish/host/site-writer'
import {
    type PublicationChanges,
    createPublicationPage,
    runPublish,
    suggestPublicationId,
    summarisePublishing,
    updatePublicationPage,
} from '$lib/workspace/publish-service'

import { chromiumStatus, openDiagramRenderer } from './diagrams'
import type { HeadlessGraph } from './headless-graph'
import { createNodePublishEnvironment, needsMermaid, nodeSiteFolder } from './publish-environment'
import { defaultPublishFoldersPath, publishFolderOf, publishGraphKey, readPublishFolders } from './publish-folders'
import { ToolError } from './tools'

/** What the tools need from the process: the environment and how this CLI is spelled for the user. */
export interface PublishHost {
    env?: NodeJS.ProcessEnv
    cmd?: string
}

function hostOf(host: PublishHost | undefined): { env: NodeJS.ProcessEnv; cmd: string } {
    return { env: host?.env ?? process.env, cmd: host?.cmd ?? 'etherpk-mcp' }
}

/** The publication page's mapping and body, through the raw handles: what `publish-service` writes to. */
function frontmatterStore(graph: HeadlessGraph) {
    return {
        open: (concept: string) => graph.store.openRaw(concept),
        whenReady: (concept: string) => graph.store.whenReady(concept),
        createPage: (title: string, body?: string) => graph.store.createPage(title, body),
    }
}

async function settle(graph: HeadlessGraph): Promise<void> {
    const result = await graph.settle()
    if (!result.settled) throw new ToolError('not_settled', result.message)
}

/** How a publication reads to an agent: its page's settings, and whether this machine can publish it. */
function publicationView(publication: Publication, folder: string | null) {
    return {
        id: publication.id,
        name: publication.name,
        page: publication.concept,
        kind: publication.kind,
        selection: publication.selection,
        home: publication.home ?? null,
        url: publication.url ?? null,
        theme: publication.theme,
        recent: publication.recent,
        includes: publication.includes,
        publishFolder: folder,
    }
}

async function foldersFor(graph: HeadlessGraph, env: NodeJS.ProcessEnv) {
    const folders = await readPublishFolders(defaultPublishFoldersPath(env))
    const key = publishGraphKey(graph.backend, graph.graphId)
    return (publicationId: string) => publishFolderOf(folders, key, publicationId)
}

/** The publications the graph defines, the issues in their pages, and the public documents none takes. */
export async function listPublications(graph: HeadlessGraph, host?: PublishHost) {
    const { env } = hostOf(host)
    await graph.store.refresh()
    const { source, unsettled } = await graph.publishing.readSource()
    const summary = summarisePublishing(source)
    const folderOf = await foldersFor(graph, env)
    return {
        publications: summary.publications.map((p) => publicationView(p, folderOf(p.id))),
        issues: summary.issues,
        publicInNoPublication: summary.publicInNoPublication,
        ...(unsettled.length > 0 ? { unsettled } : {}),
    }
}

export interface CreatePublicationArgs {
    /** The publication's display name, and the title of the page that defines it. */
    title: string
    /** Lower-case letters, digits and hyphens; from the title by default. */
    id?: string
    kind?: 'docs' | 'blog'
    selection?: 'named' | 'all-public'
    home?: string
    url?: string
    theme?: string
}

async function requireTheme(graph: HeadlessGraph, ref: string): Promise<void> {
    const environment = createNodePublishEnvironment({ graphTheme: (id) => graph.publishing.graphTheme(id) })
    try {
        await environment.loadTheme(ref)
    } catch (error) {
        throw new ToolError('invalid_argument', error instanceof Error ? error.message : String(error))
    }
}

/** Create a publication: a page whose frontmatter defines it and whose outline is its navigation. */
export async function createPublication(graph: HeadlessGraph, args: CreatePublicationArgs, host?: PublishHost) {
    const { env } = hostOf(host)
    const title = args.title.trim()
    if (title === '') throw new ToolError('invalid_argument', 'title must not be empty.')
    const id = (args.id ?? suggestPublicationId(title)).trim()
    if (!isPublicationId(id)) throw new ToolError('invalid_argument', `"${id}" is not a publication id: use lower-case letters, digits and hyphens, like "docs".`)
    const kind = args.kind ?? 'docs'
    if (kind !== 'docs' && kind !== 'blog') throw new ToolError('invalid_argument', 'kind must be "docs" or "blog".')
    const selection = args.selection ?? 'named'
    if (selection !== 'named' && selection !== 'all-public') throw new ToolError('invalid_argument', 'selection must be "named" or "all-public".')
    await graph.store.refresh()
    const before = summarisePublishing((await graph.publishing.readSource()).source)
    if (before.publications.some((p) => p.id === id)) throw new ToolError('already_exists', `A publication with the id "${id}" already exists (page "${before.publications.find((p) => p.id === id)!.concept}").`)
    if (graph.store.listDocuments().some((d) => d.key === title.toLowerCase() || d.aliases.some((a) => a.toLowerCase() === title.toLowerCase()))) {
        throw new ToolError('already_exists', `A document already answers to "${title}"; choose another title for the publication page.`)
    }
    if (args.theme) await requireTheme(graph, args.theme)
    const store = frontmatterStore(graph)
    const concept = await createPublicationPage(store, { title, id, kind, selection, home: args.home, url: args.url })
    // Settled before it is read back: a folder's source is its files, and the page is in a
    // buffer until the flush.
    await settle(graph)
    if (args.theme) {
        const created = summarisePublishing((await graph.publishing.readSource()).source).publications.find((p) => p.id === id)
        if (created) await updatePublicationPage(store, concept, created, { theme: args.theme })
        await settle(graph)
    }
    const after = summarisePublishing((await graph.publishing.readSource()).source).publications.find((p) => p.id === id)
    const folderOf = await foldersFor(graph, env)
    return { created: true, publication: after ? publicationView(after, folderOf(id)) : { id, page: concept } }
}

export interface UpdatePublicationArgs {
    id: string
    changes: PublicationChanges
}

/** Change a publication's settings on its page: fields, the front-page count, include slots. */
export async function updatePublication(graph: HeadlessGraph, args: UpdatePublicationArgs, host?: PublishHost) {
    const { env } = hostOf(host)
    await graph.store.refresh()
    const current = summarisePublishing((await graph.publishing.readSource()).source).publications.find((p) => p.id === args.id.trim())
    if (!current) throw new ToolError('publication_not_found', `No publication has the id "${args.id}"; list_publications shows them.`)
    const changes = args.changes ?? {}
    if (changes.kind !== undefined && changes.kind !== null && changes.kind !== 'docs' && changes.kind !== 'blog') throw new ToolError('invalid_argument', 'kind must be "docs" or "blog".')
    if (changes.selection !== undefined && changes.selection !== null && changes.selection !== 'named' && changes.selection !== 'all-public') throw new ToolError('invalid_argument', 'selection must be "named" or "all-public".')
    if (changes.recent !== undefined && changes.recent !== null && (!Number.isInteger(changes.recent) || changes.recent < 0)) throw new ToolError('invalid_argument', 'recent must be a non-negative whole number, or null for the default.')
    if (changes.theme) await requireTheme(graph, changes.theme)
    for (const page of Object.values(changes.includes ?? {})) {
        if (page && !graph.store.listDocuments().some((d) => d.key === page.trim().toLowerCase() || d.aliases.some((a) => a.toLowerCase() === page.trim().toLowerCase()))) {
            throw new ToolError('not_found', `No document is named "${page}" to fill the include.`)
        }
    }
    await updatePublicationPage(frontmatterStore(graph), current.concept, current, changes)
    await settle(graph)
    const after = summarisePublishing((await graph.publishing.readSource()).source).publications.find((p) => p.id === current.id)
    const folderOf = await foldersFor(graph, env)
    return { publication: publicationView(after ?? current, folderOf(current.id)) }
}

export interface PublishArgs {
    id: string
}

/** The first entries of a long list, and how many there were. */
function head<T>(items: readonly T[], n = 20): { total: number; first: T[] } {
    return { total: items.length, first: items.slice(0, n) }
}

/**
 * Publish one publication into its Publish Folder and report. The folder is the one a person
 * set for this graph and publication on this machine (ADR 0086); a publish with Mermaid needs
 * the browser (ADR 0084). The full report is in the folder as `etherpk-publish.json`.
 */
export async function publish(graph: HeadlessGraph, args: PublishArgs, host?: PublishHost) {
    const { env, cmd } = hostOf(host)
    await graph.store.refresh()
    const { source, unsettled } = await graph.publishing.readSource()
    const summary = summarisePublishing(source)
    const publication = summary.publications.find((p) => p.id === args.id.trim())
    if (!publication) throw new ToolError('publication_not_found', `No publication has the id "${args.id}"; list_publications shows them.`)
    const folder = (await foldersFor(graph, env))(publication.id)
    if (!folder) {
        const where = graph.backend.kind === 'folder' ? `--folder "${graph.backend.path}"` : `--graph "${graph.name}"`
        throw new ToolError(
            'no_publish_folder',
            `No publish folder is set for "${publication.name}" on this machine. Ask the user to run: ${cmd} publish ${where} --publication ${publication.id} --out <dir> - that publishes once and remembers the folder for this tool.`,
        )
    }
    const selected = selectDocuments(source.documents, publication, summary.publications)
    const includeTexts = Object.values(publication.includes)
        .map((concept) => source.documents.find((d) => d.concept.toLowerCase() === concept.toLowerCase())?.text ?? '')
    let renderer = null
    if (needsMermaid([...selected.included.map((d) => d.text), ...includeTexts])) {
        renderer = await openDiagramRenderer(env)
        if (!renderer) {
            const status = await chromiumStatus(env, cmd)
            throw new ToolError(
                'chromium_unavailable',
                `"${publication.name}" has Mermaid diagrams, which a publish draws with a browser, and none is set up on this computer. Ask the user to run: ${status.setupCommand} (or set ETHERPK_CHROMIUM to a Chromium on this machine). Nothing was published.`,
            )
        }
    }
    try {
        const environment = createNodePublishEnvironment({ graphTheme: (id) => graph.publishing.graphTheme(id), renderer })
        const run = await runPublish(publication, { source, environment, unsettled })
        const written = run.report.ok ? await writeSite(nodeSiteFolder(folder), run.bundle, { seeded: run.seeded, agentsMd: run.agentsMd }) : null
        const excludedByReason: Record<string, number> = {}
        for (const e of run.report.excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1
        return {
            ok: run.report.ok,
            publication: run.report.publication,
            folder,
            written: written ? { written: written.written, unchanged: written.unchanged, deleted: head(written.deleted) } : null,
            included: head(run.report.included.map((d) => d.concept)),
            excluded: { total: run.report.excluded.length, byReason: excludedByReason },
            errors: run.report.errors,
            warnings: run.report.warnings,
            missingLinks: head(run.report.missingLinks),
            assets: { copied: run.report.assets.copied.length, missing: run.report.assets.missing },
            collisions: run.report.collisions,
            publicInNoPublication: run.report.publicInNoPublication,
            ...(unsettled.length > 0 ? { unsettled } : {}),
            report: run.report.ok ? `${folder}/etherpk-publish.json` : null,
        }
    } finally {
        await renderer?.dispose()
    }
}

/** The publishing half of `graph_info`: each publication with its folder here, and whether diagrams can be drawn. */
export async function publishingInfo(graph: HeadlessGraph, host?: PublishHost) {
    const { env, cmd } = hostOf(host)
    const { source } = await graph.publishing.readSource()
    const folderOf = await foldersFor(graph, env)
    const chromium = await chromiumStatus(env, cmd)
    return {
        publications: summarisePublishing(source).publications.map((p) => ({ id: p.id, name: p.name, kind: p.kind, publishFolder: folderOf(p.id) })),
        mermaid: { available: chromium.executable !== null, ...(chromium.executable ? {} : { setup: chromium.setupCommand }) },
    }
}
