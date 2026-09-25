/**
 * The theme tools ([[2026-09-20 Headless Client Assets Rename And Publishing]] → Themes): what
 * the Client's Theme editor and the Publish tab's theme controls do, for a coding agent. A
 * [[Theme]] is data - Mustache templates, a stylesheet, a script, a manifest - which is exactly
 * what an agent edits well and a person edits badly, so the tools give the whole loop: read a
 * theme's files out to disk, copy a bundled or url theme into the graph (the only kind that can
 * be edited), point a publication at it, write files back one at a time or as a folder, render
 * a preview to look at (and photograph, with the browser), then `publish`.
 *
 * The rules are the Client's: a bundled theme is never edited in place (`create_theme` or
 * `customise_publication_theme` make the graph's own copy first); a theme a publication's saved
 * mapping names cannot be deleted; a file path is one the theme format allows (`theme.json`,
 * `layouts/`, `partials/`, `assets/`); and every write is validated afterwards, so a manifest an
 * agent broke is reported on the write that broke it rather than on the next publish.
 */

import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bundledTheme, bundledThemeList } from '@appsoftwareltd/etherpk-themes'

import { previewPages } from '$lib/document/publish/host/preview'
import { publishPublication } from '$lib/document/publish/publish'
import { SAMPLE_PUBLICATION, SAMPLE_SOURCE } from '$lib/document/publish/sample-graph'
import { type GraphTheme, graphThemeFromFiles, isGraphThemeId, isThemeFilePath, themeFilesOf } from '$lib/document/publish/theme/graph-theme'
import { themeFileErrors } from '$lib/document/publish/theme/manifest'
import { isThemeUrl } from '$lib/document/publish/theme/sources'
import type { Publication, SiteBundle } from '$lib/document/publish/types'
import { copyThemeForGraph, freeThemeId, summarisePublishing, updatePublicationPage } from '$lib/workspace/publish-service'

import { chromiumStatus, launchChromium, openDiagramRenderer } from './diagrams'
import type { HeadlessGraph } from './headless-graph'
import { FolderRefused, folderUnder, previewRequestAllowed } from './local-folders'
import { createNodePublishEnvironment, needsMermaid, nodeSiteFolder } from './publish-environment'
import { fetchPublicText } from './public-fetch'
import type { PublishHost } from './publish-tools'
import { ToolError } from './tools'

function hostOf(host: PublishHost | undefined): { env: NodeJS.ProcessEnv; cmd: string } {
    return { env: host?.env ?? process.env, cmd: host?.cmd ?? 'etherpk-mcp' }
}

/** The graph's downloads directory: every folder these tools write to, or read a theme back from, is under it. */
function downloadsOf(graph: HeadlessGraph): string {
    return graph.assets?.downloadsDir ?? join(process.cwd(), 'etherpk-downloads')
}

/** A folder under the downloads directory, or the tool's refusal. */
async function toolFolder(graph: HeadlessGraph, requested: string | undefined, fallback: string): Promise<string> {
    try {
        return await folderUnder(downloadsOf(graph), requested, fallback)
    } catch (error) {
        if (error instanceof FolderRefused) throw new ToolError('invalid_argument', error.message)
        throw error
    }
}

async function settle(graph: HeadlessGraph): Promise<void> {
    const result = await graph.settle()
    if (!result.settled) throw new ToolError('not_settled', result.message)
}

/** A url theme's files, from public https hosts only (see public-fetch.ts). */
const fetchText = (url: string): Promise<string> => fetchPublicText(url)

/** The publications whose saved mapping names a theme: what makes it undeletable. */
async function publicationsUsing(graph: HeadlessGraph, themeId: string): Promise<Publication[]> {
    const { source } = await graph.publishing.readSource()
    return summarisePublishing(source).publications.filter((p) => p.theme === themeId)
}

/** The problems a graph theme has as it stands: none for a usable one. */
function validationOf(theme: GraphTheme): string[] {
    try {
        return themeFileErrors(themeFilesOf(theme))
    } catch (error) {
        return [error instanceof Error ? error.message : String(error)]
    }
}

function manifestSummary(theme: GraphTheme | { files: Map<string, string> }) {
    const json = theme.files instanceof Map ? theme.files.get('theme.json') : theme.files['theme.json']
    if (!json) return null
    try {
        const parsed = JSON.parse(json) as { title?: string; version?: string; contract?: number; kinds?: string[]; includes?: Array<{ name: string; description?: string; kind?: string }>; description?: string }
        return { title: parsed.title ?? null, version: parsed.version ?? null, contract: parsed.contract ?? null, kinds: parsed.kinds ?? [], includes: parsed.includes ?? [], description: parsed.description ?? null }
    } catch {
        return null
    }
}

async function themeView(graph: HeadlessGraph, theme: GraphTheme) {
    return {
        id: theme.id,
        name: theme.name,
        editable: true as const,
        origin: theme.origin ?? null,
        updatedAt: theme.updatedAt ?? null,
        files: Object.keys(theme.files).sort(),
        manifest: manifestSummary(theme),
        errors: validationOf(theme),
        usedBy: (await publicationsUsing(graph, theme.id)).map((p) => p.id),
    }
}

/** Every theme a publication here could name: the bundled ones (read-only) and the graph's own. */
export async function listThemes(graph: HeadlessGraph) {
    await graph.store.refresh()
    const bundled = bundledThemeList().map(({ name, title }) => {
        const theme = bundledTheme(name)!
        return { name, title, editable: false as const, files: [...theme.files.keys()].sort(), manifest: manifestSummary(theme) }
    })
    const own = await graph.themes.list()
    return { bundled, graph: await Promise.all(own.map((theme) => themeView(graph, theme))) }
}

/** A theme's files by reference: the graph's own by id, a bundled one by name, a url. */
async function filesOf(graph: HeadlessGraph, ref: string): Promise<{ source: 'graph' | 'bundled' | 'url'; files: Map<string, string>; theme?: GraphTheme }> {
    const own = await graph.themes.get(ref)
    if (own) return { source: 'graph', files: new Map(Object.entries(own.files)), theme: own }
    const bundled = bundledTheme(ref)
    if (bundled) return { source: 'bundled', files: new Map(bundled.files) }
    if (isThemeUrl(ref)) {
        const fetched = await copyThemeForGraph(ref, 'fetched', 'fetched', { existingIds: [], fetchText })
        return { source: 'url', files: new Map(Object.entries(fetched.files)) }
    }
    throw new ToolError('theme_not_found', `No theme is called "${ref}": not a theme in this graph, not bundled (${bundledThemeList().map((t) => t.name).join(', ')}), not a url.`)
}

export interface ReadThemeArgs {
    /** A graph theme id, a bundled theme name, or a url. */
    ref: string
    /** A folder under the graph's downloads directory to write the files to; `themes/<ref>` there by default. */
    out_dir?: string
}

/**
 * Write a theme's files to a directory on this machine, one file per path, so the agent can
 * read and edit them with its own tools, and say what the theme is. Editing there changes
 * nothing in the graph until `write_theme_file` or `import_theme_folder` brings it back.
 */
export async function readTheme(graph: HeadlessGraph, args: ReadThemeArgs) {
    await graph.store.refresh()
    const ref = args.ref.trim()
    const { source, files, theme } = await filesOf(graph, ref)
    const folder = await toolFolder(graph, args.out_dir, join('themes', ref.replace(/[^A-Za-z0-9._-]/g, '_')))
    const site = nodeSiteFolder(folder)
    const written: Array<{ path: string; bytes: number }> = []
    for (const [path, text] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        await site.writeFile(path, text)
        written.push({ path, bytes: Buffer.byteLength(text) })
    }
    return {
        ref,
        source,
        editable: source === 'graph',
        ...(theme ? { id: theme.id, name: theme.name, origin: theme.origin ?? null } : {}),
        folder,
        files: written,
        manifest: manifestSummary({ files }),
        ...(source !== 'graph' ? { note: 'A bundled or url theme cannot be edited in place: create_theme (or customise_publication_theme) makes a copy in the graph that can.' } : {}),
    }
}

export interface ReadThemeFileArgs {
    ref: string
    /** `theme.json`, or a path under `layouts/`, `partials/` or `assets/`. */
    path: string
}

/** One file of a theme, as text. */
export async function readThemeFile(graph: HeadlessGraph, args: ReadThemeFileArgs) {
    await graph.store.refresh()
    const { source, files } = await filesOf(graph, args.ref.trim())
    const text = files.get(args.path)
    if (text === undefined) throw new ToolError('not_found', `The theme "${args.ref}" has no file "${args.path}". Its files: ${[...files.keys()].sort().join(', ')}.`)
    return { ref: args.ref.trim(), source, editable: source === 'graph', path: args.path, text }
}

export interface CreateThemeArgs {
    /** What to copy: a bundled theme name (etherpk-docs, etherpk-blog), a url, or one of the graph's themes. */
    from: string
    /** The new theme's id; from the source's name by default, made unique. */
    id?: string
    name?: string
}

/** A theme of the graph's own, copied from a bundled theme, a url or another graph theme, ready to edit. */
export async function createTheme(graph: HeadlessGraph, args: CreateThemeArgs) {
    await graph.store.refresh()
    const from = args.from.trim()
    const existing = (await graph.themes.list()).map((theme) => theme.id)
    const id = args.id?.trim() || freeThemeId(from.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9]+/g, '-'), existing)
    if (!isGraphThemeId(id)) throw new ToolError('invalid_argument', `"${id}" is not a theme id: use lower-case letters, digits and hyphens.`)
    if (existing.includes(id)) throw new ToolError('already_exists', `The graph already has a theme called "${id}".`)
    const name = args.name?.trim() || id
    let theme: GraphTheme
    const own = await graph.themes.get(from)
    if (own) {
        theme = graphThemeFromFiles(id, name, new Map(Object.entries(own.files)), own.origin ?? own.id)
    } else {
        try {
            theme = await copyThemeForGraph(from, id, name, { existingIds: existing, fetchText })
        } catch (error) {
            throw new ToolError('theme_not_found', error instanceof Error ? error.message : String(error))
        }
    }
    await graph.themes.put(theme)
    await settle(graph)
    return { created: true, theme: await themeView(graph, theme) }
}

export interface CustomisePublicationThemeArgs {
    /** The publication whose theme should become one of the graph's own. */
    publication: string
    id?: string
    name?: string
}

/**
 * The Publish tab's "Customise theme": if the publication uses a bundled or url theme, copy it
 * into the graph and point the publication at the copy; if it already uses a graph theme, say
 * which. Either way the answer is a theme the agent can edit.
 */
export async function customisePublicationTheme(graph: HeadlessGraph, args: CustomisePublicationThemeArgs) {
    await graph.store.refresh()
    const { source } = await graph.publishing.readSource()
    const publication = summarisePublishing(source).publications.find((p) => p.id === args.publication.trim())
    if (!publication) throw new ToolError('publication_not_found', `No publication has the id "${args.publication}"; list_publications shows them.`)
    const current = await graph.themes.get(publication.theme)
    if (current) return { created: false, publication: publication.id, theme: await themeView(graph, current) }
    const existing = (await graph.themes.list()).map((theme) => theme.id)
    const id = args.id?.trim() || freeThemeId(`${publication.id}-theme`, existing)
    if (!isGraphThemeId(id)) throw new ToolError('invalid_argument', `"${id}" is not a theme id: use lower-case letters, digits and hyphens.`)
    if (existing.includes(id)) throw new ToolError('already_exists', `The graph already has a theme called "${id}".`)
    let theme: GraphTheme
    try {
        theme = await copyThemeForGraph(publication.theme, id, args.name?.trim() || `${publication.name} theme`, { existingIds: existing, fetchText })
    } catch (error) {
        throw new ToolError('theme_not_found', error instanceof Error ? error.message : String(error))
    }
    await graph.themes.put(theme)
    await updatePublicationPage(
        { open: (concept) => graph.store.openRaw(concept), whenReady: (concept) => graph.store.whenReady(concept) },
        publication.concept,
        publication,
        { theme: id },
    )
    await settle(graph)
    return { created: true, publication: publication.id, theme: await themeView(graph, theme) }
}

async function requireEditable(graph: HeadlessGraph, id: string): Promise<GraphTheme> {
    const own = await graph.themes.get(id)
    if (own) return own
    if (bundledTheme(id)) throw new ToolError('theme_not_editable', `"${id}" is a bundled theme and cannot be edited in place. create_theme (or customise_publication_theme for the publication that uses it) makes a copy in the graph that can be.`)
    throw new ToolError('theme_not_found', `No theme in this graph is called "${id}"; list_themes shows them.`)
}

function requireThemePath(path: string): string {
    const clean = path.trim().replace(/^\.?\//, '')
    if (!isThemeFilePath(clean)) throw new ToolError('invalid_argument', `"${path}" is not a theme file path: theme.json, or a file under layouts/, partials/ or assets/.`)
    return clean
}

export interface WriteThemeFileArgs {
    id: string
    path: string
    text: string
}

/** Set one file of a graph theme (creating it), then validate the theme and report. */
export async function writeThemeFile(graph: HeadlessGraph, args: WriteThemeFileArgs) {
    await graph.store.refresh()
    const theme = await requireEditable(graph, args.id.trim())
    const path = requireThemePath(args.path)
    if (typeof args.text !== 'string') throw new ToolError('invalid_argument', 'text must be a string.')
    await graph.themes.putFile(theme.id, path, args.text)
    await settle(graph)
    const after = (await graph.themes.get(theme.id)) ?? { ...theme, files: { ...theme.files, [path]: args.text } }
    return { id: theme.id, path, bytes: Buffer.byteLength(args.text), errors: validationOf(after) }
}

export interface DeleteThemeFileArgs {
    id: string
    path: string
}

/** Remove one file from a graph theme, then validate: removing `layouts/page.html` is reported, not refused. */
export async function deleteThemeFile(graph: HeadlessGraph, args: DeleteThemeFileArgs) {
    await graph.store.refresh()
    const theme = await requireEditable(graph, args.id.trim())
    const path = requireThemePath(args.path)
    if (!(path in theme.files)) throw new ToolError('not_found', `The theme "${theme.id}" has no file "${path}".`)
    await graph.themes.removeFile(theme.id, path)
    await settle(graph)
    const after = (await graph.themes.get(theme.id)) ?? theme
    return { id: theme.id, path, removed: true, errors: validationOf(after) }
}

export interface ImportThemeFolderArgs {
    id: string
    /** A folder under the graph's downloads directory holding `theme.json` and `layouts/`, `partials/`, `assets/` - as `read_theme` wrote it, edited. */
    dir: string
}

/** Bounds on a theme folder: far beyond a real theme, and short of a whole disk. */
const THEME_FOLDER_LIMITS = { files: 500, depth: 6, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 }

/**
 * Every allowed file under a directory, as the theme's whole file set. Symbolic links are not
 * followed, so a folder cannot pull in a file from elsewhere on disk, and the walk stops at the
 * limits above rather than reading whatever tree it was pointed at.
 */
async function filesUnder(base: string): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    let seen = 0
    let total = 0
    const walk = async (at: string, depth: number): Promise<void> => {
        if (depth > THEME_FOLDER_LIMITS.depth) return
        for (const entry of await readdir(at, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue
            const full = join(at, entry.name)
            if (entry.isDirectory()) {
                if (entry.name !== '.git' && entry.name !== 'node_modules') await walk(full, depth + 1)
                continue
            }
            if (!entry.isFile()) continue
            if (++seen > THEME_FOLDER_LIMITS.files) throw new Error(`it holds more than ${THEME_FOLDER_LIMITS.files} files`)
            const path = relative(base, full).split(sep).join('/')
            if (!isThemeFilePath(path)) continue
            const { size } = await lstat(full)
            if (size > THEME_FOLDER_LIMITS.fileBytes) throw new Error(`${path} is larger than ${THEME_FOLDER_LIMITS.fileBytes} bytes`)
            total += size
            if (total > THEME_FOLDER_LIMITS.totalBytes) throw new Error(`its theme files come to more than ${THEME_FOLDER_LIMITS.totalBytes} bytes`)
            files.set(path, await readFile(full, 'utf8'))
        }
    }
    await walk(base, 0)
    return files
}

/**
 * Replace a graph theme's files with a directory's: the way back from `read_theme` after the
 * agent has edited the copy. Files the directory no longer has are removed from the theme; a
 * file outside the theme's allowed places is skipped and named.
 */
export async function importThemeFolder(graph: HeadlessGraph, args: ImportThemeFolderArgs) {
    await graph.store.refresh()
    const theme = await requireEditable(graph, args.id.trim())
    if (!args.dir?.trim()) throw new ToolError('invalid_argument', 'dir must name the theme folder, as read_theme returned it.')
    const dir = await toolFolder(graph, args.dir, '')
    let files: Map<string, string>
    try {
        files = await filesUnder(dir)
    } catch (error) {
        throw new ToolError('invalid_argument', `Cannot read "${args.dir}": ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!files.has('theme.json')) throw new ToolError('invalid_argument', `"${args.dir}" has no theme.json; a theme folder has one at its top.`)
    const next: GraphTheme = { ...theme, files: Object.fromEntries(files), updatedAt: new Date().toISOString() }
    await graph.themes.put(next)
    await settle(graph)
    const before = new Set(Object.keys(theme.files))
    return {
        id: theme.id,
        files: [...files.keys()].sort(),
        added: [...files.keys()].filter((path) => !before.has(path)).sort(),
        removed: [...before].filter((path) => !files.has(path)).sort(),
        errors: validationOf(next),
    }
}

export interface DeleteThemeArgs {
    id: string
}

/** Remove a graph theme, unless a publication's saved settings name it. */
export async function deleteTheme(graph: HeadlessGraph, args: DeleteThemeArgs) {
    await graph.store.refresh()
    const theme = await requireEditable(graph, args.id.trim())
    const users = await publicationsUsing(graph, theme.id)
    if (users.length > 0) {
        throw new ToolError('theme_in_use', `"${theme.id}" is the theme of ${users.map((p) => `"${p.name}"`).join(', ')}; point ${users.length === 1 ? 'that publication' : 'those publications'} at another theme (update_publication) first.`)
    }
    await graph.themes.remove(theme.id)
    await settle(graph)
    return { id: theme.id, deleted: true }
}

export interface PreviewThemeArgs {
    /** The theme to render; the publication's own when only a publication is given. */
    theme?: string
    /** Render this publication's real pages; the sample site when absent. */
    publication?: string
    /** A folder under the graph's downloads directory; `previews/<theme>` there by default, emptied first. */
    out_dir?: string
    /** Also photograph the front page and one content page with the browser, desktop and phone widths. */
    screenshots?: boolean
}

/**
 * Render a theme to a folder on this machine and say where: the publication's real site when
 * one is named, the sample site the Theme editor previews over otherwise. A preview is scratch,
 * not a [[Publish Folder]]: it is always under the graph's downloads directory, the default folder
 * there is emptied first, and a named `out_dir` (also under it) is written into as it is. With `screenshots`, the browser
 * photographs the front page and the first other page at desktop and phone widths, so the agent
 * can look at what it changed.
 */
export async function previewTheme(graph: HeadlessGraph, args: PreviewThemeArgs, host?: PublishHost) {
    const { env, cmd } = hostOf(host)
    await graph.store.refresh()
    let publication: Publication = SAMPLE_PUBLICATION
    let source = SAMPLE_SOURCE
    let unsettled: string[] = []
    if (args.publication?.trim()) {
        const read = await graph.publishing.readSource()
        const found = summarisePublishing(read.source).publications.find((p) => p.id === args.publication!.trim())
        if (!found) throw new ToolError('publication_not_found', `No publication has the id "${args.publication}"; list_publications shows them.`)
        publication = found
        source = read.source
        unsettled = read.unsettled
    }
    const themeRef = args.theme?.trim() || (args.publication ? publication.theme : undefined)
    if (!themeRef) throw new ToolError('invalid_argument', 'Give a theme to preview, a publication whose theme to preview, or both.')
    await filesOf(graph, themeRef) // a clear refusal for an unknown reference
    publication = { ...publication, theme: themeRef }

    const bodies = source.documents.map((d) => d.text)
    const renderer = needsMermaid(bodies) ? await openDiagramRenderer(env) : null
    try {
        const environment = createNodePublishEnvironment({ graphTheme: (id) => graph.publishing.graphTheme(id), renderer })
        const { bundle, report } = await publishPublication(source, publication, environment)
        const scratch = !args.out_dir?.trim()
        const folder = await toolFolder(graph, args.out_dir, join('previews', themeRef.replace(/[^A-Za-z0-9._-]/g, '_')))
        if (scratch) await rm(folder, { recursive: true, force: true })
        await writeBundle(folder, bundle)
        const pages = previewPages(bundle)
        const screenshots = args.screenshots ? await photograph(env, folder, pages) : undefined
        const chromium = args.screenshots && !screenshots ? await chromiumStatus(env, cmd) : null
        return {
            theme: themeRef,
            publication: publication.id,
            sample: !args.publication,
            folder,
            index: join(folder, 'index.html'),
            pages,
            ok: report.ok,
            errors: report.errors,
            warnings: report.warnings,
            missingLinks: report.missingLinks.slice(0, 20),
            ...(unsettled.length > 0 ? { unsettled } : {}),
            ...(screenshots ? { screenshots } : {}),
            ...(chromium ? { screenshots: null, note: `No browser to photograph with; run ${chromium.setupCommand} or set ETHERPK_CHROMIUM.` } : {}),
        }
    } finally {
        await renderer?.dispose()
    }
}

/** The rendered site into the folder, through the writer `publish` uses: no path may leave the folder. */
async function writeBundle(folder: string, bundle: SiteBundle): Promise<void> {
    const site = nodeSiteFolder(folder)
    for (const [path, content] of bundle) await site.writeFile(path, content)
}

/** The front page and the first other page, desktop and phone, as PNGs beside the site. */
async function photograph(env: NodeJS.ProcessEnv, folder: string, pages: string[]): Promise<Array<{ page: string; width: number; path: string }> | null> {
    const browser = await launchChromium(env)
    if (!browser) return null
    try {
        const shots: Array<{ page: string; width: number; path: string }> = []
        const targets = ['index.html', ...pages.filter((p) => p !== 'index.html' && p !== '404.html').slice(0, 1)]
        for (const page of targets) {
            for (const width of [1280, 390]) {
                // Offline, and only the preview's own files: the theme's script runs here.
                const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, offline: true })
                await context.route('**/*', (route) => (previewRequestAllowed(route.request().url(), folder) ? route.continue() : route.abort()))
                const tab = await context.newPage()
                await tab.goto(pathToFileURL(join(folder, page)).href, { waitUntil: 'load' })
                const out = join(folder, `preview-${page.replace(/\.html$/, '')}-${width}.png`)
                await tab.screenshot({ path: out, fullPage: true })
                await context.close()
                shots.push({ page, width, path: out })
            }
        }
        return shots
    } finally {
        await browser.close().catch(() => {})
    }
}
