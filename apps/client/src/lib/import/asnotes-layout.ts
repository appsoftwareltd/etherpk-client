/**
 * The layout of an AS Notes workspace, read before any note is converted: the folder AS Notes
 * indexes, where its journals and templates live, and which files are not notes at all. Those are
 * the publish setup and the sites it generates, what `.asnotesignore` excludes, and encrypted
 * notes, which an import never reads (ADR 0115).
 *
 * AS Notes keeps its settings in VS Code's, so the folders it was told to use are read from the
 * workspace's `.vscode/settings.json` when the picked folder has one. Without it, AS Notes's own
 * defaults apply, which is what most workspaces use.
 */

import { stripJsonComments } from '$lib/storage/fs/theme-files'

import { findFile, isJunkPath, readText } from './source'
import type { ReportEntry, SourceFile } from './types'

export interface AsNotesLayout {
    /** The folder AS Notes indexes, relative to the picked folder: `''` or one top-level folder. */
    root: string
    /** Root-relative folders, without slashes at either end. */
    journalFolder: string
    templateFolder: string
    /** The files to convert: under the root, paths made root-relative, everything that is not note content removed. */
    files: SourceFile[]
}

/** `.asnotes/` in the folder itself, or in one of its top-level folders (`as-notes.rootDirectory`). */
const MARKER = /^(?:([^/]+)\/)?\.asnotes\//

/** An AS Notes encrypted note, whether it holds ciphertext or AS Notes has decrypted it in place. */
export function isEncryptedNotePath(path: string): boolean {
    return /\.enc\.md$/i.test(path)
}

/**
 * The folder AS Notes indexes: where `.asnotes/` is. The picked folder itself wins over a folder
 * inside it, and without a marker (the format chosen by hand) the whole picked folder is used.
 */
export function notesRootOf(paths: string[]): string {
    let nested: string | null = null
    for (const path of paths) {
        const match = MARKER.exec(path)
        if (!match) continue
        if (match[1] === undefined) return ''
        nested ??= match[1]
    }
    return nested ?? ''
}

/** `path` relative to `root`, or null when it lies outside it. */
function withinRoot(path: string, root: string): string | null {
    if (root === '') return path
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

/**
 * The encrypted notes an AS Notes import leaves out, root-relative, in the order given. The
 * dialog counts them before the run, so the person knows before anything is imported.
 */
export function encryptedNotePaths(files: SourceFile[]): string[] {
    const root = notesRootOf(files.map((f) => f.path))
    return files
        .map((f) => withinRoot(f.path, root))
        .filter((path): path is string => path !== null && !isJunkPath(path) && isEncryptedNotePath(path))
}

/** A folder setting as a root-relative path: backslashes to slashes, no slashes at either end. */
function cleanFolder(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const clean = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
    return clean === '' || clean === '.' ? null : clean
}

/**
 * JSON as VS Code writes and reads it: comments allowed, and a trailing comma before a closing
 * bracket tolerated. Not a full JSONC parser: a comma-then-bracket inside a string value would
 * be changed too, which no setting AS Notes reads contains.
 */
function parseLooseJson(text: string): unknown {
    return JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, '$1'))
}

/** The workspace's VS Code settings, or `{}` when there are none or they cannot be read. */
async function readWorkspaceSettings(files: SourceFile[], report: ReportEntry[]): Promise<Record<string, unknown>> {
    const file = findFile(files, '.vscode/settings.json')
    if (!file) return {}
    try {
        const parsed = parseLooseJson(await readText(file))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
        // Reported below, like a settings file that is valid JSON but not an object.
    }
    report.push({
        category: 'unsupported',
        detail: '.vscode/settings.json could not be read, so the journal and template folders were taken to be AS Notes\'s defaults',
    })
    return {}
}

/**
 * One `.asnotesignore` line this importer applies: a plain folder or file name, with or without
 * a leading `/` (anchored at the notes folder) or a trailing `/` (folders only).
 */
interface IgnoreRule {
    segments: string[]
    anchored: boolean
    folderOnly: boolean
}

/**
 * The `.asnotesignore` rules. The file is gitignore syntax, and the plain names people write
 * there are applied the way gitignore applies them, ignoring case as AS Notes does. A pattern
 * with a wildcard or a `!` would need a full gitignore matcher to be applied correctly, so it is
 * reported and not applied rather than half matched.
 */
function parseIgnoreFile(text: string): { rules: IgnoreRule[]; skipped: string[] } {
    const rules: IgnoreRule[] = []
    const skipped: string[] = []
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd()
        if (line.trim() === '' || line.startsWith('#')) continue
        if (line.startsWith('!') || /[*?[\\]/.test(line)) {
            skipped.push(line.trim())
            continue
        }
        const folderOnly = line.endsWith('/')
        const name = line.replace(/\/+$/, '')
        const anchored = name.startsWith('/') || name.replace(/^\/+/, '').includes('/')
        const segments = name.replace(/^\/+/, '').toLowerCase().split('/')
        if (segments.some((s) => s === '')) continue
        rules.push({ segments, anchored, folderOnly })
    }
    return { rules, skipped }
}

/** Whether a rule excludes a root-relative file path. */
function ignores(rule: IgnoreRule, path: string): boolean {
    const segments = path.toLowerCase().split('/')
    const n = rule.segments.length
    // The rule names the file itself (only a rule that is not folder-only can), or a folder the file is inside.
    const matchesAt = (start: number) =>
        rule.segments.every((s, i) => segments[start + i] === s) && (start + n < segments.length || !rule.folderOnly)
    if (rule.anchored) return n <= segments.length && matchesAt(0)
    return segments.some((_, start) => start + n <= segments.length && matchesAt(start))
}

/** The folders and files the publish setup owns, root-relative. */
interface PublishSetup {
    configs: string[]
    /** Layout, include and theme folders. */
    setupFolders: string[]
    /** The folders the publisher writes each site to. */
    outputFolders: string[]
}

const PUBLISH_CONFIG = /^asnotes-publish(?:\.[^/]+)?\.json$/i
/** The folders the AS Notes publisher looks in by convention, beside the notes. */
const PUBLISH_FOLDER = /^asnotes-publish\.(?:layouts|includes|themes)(?:\.[^/]+)?$/i

/**
 * The AS Notes publish setup: every `asnotes-publish*.json` at the root, the layout, include and
 * theme folders they name or that follow the naming convention, and each config's `outputDir`.
 * EtherPK publishes through a Publication instead, and an output folder holds a generated HTML
 * site that would otherwise arrive as hundreds of stray files.
 */
async function readPublishSetup(files: SourceFile[], report: ReportEntry[]): Promise<PublishSetup> {
    const configs: string[] = []
    const setupFolders = new Set<string>()
    const outputFolders = new Set<string>()
    for (const file of files) {
        const topFolder = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : null
        if (topFolder !== null && PUBLISH_FOLDER.test(topFolder)) setupFolders.add(topFolder)
        if (!PUBLISH_CONFIG.test(file.path)) continue
        configs.push(file.path)
        try {
            const config = parseLooseJson(await readText(file)) as Record<string, unknown>
            for (const key of ['layouts', 'includes', 'themes']) {
                const folder = cleanFolder(config?.[key])
                if (folder) setupFolders.add(folder)
            }
            const output = cleanFolder(config?.outputDir)
            if (output) outputFolders.add(output)
        } catch {
            report.push({
                category: 'unsupported',
                detail: `${file.path} could not be read, so the site it generates may have been imported as files`,
            })
        }
    }
    return { configs, setupFolders: [...setupFolders].sort(), outputFolders: [...outputFolders].sort() }
}

function isUnder(path: string, folder: string): boolean {
    return path.toLowerCase().startsWith(`${folder.toLowerCase()}/`)
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)

export async function readAsNotesLayout(files: SourceFile[], report: ReportEntry[]): Promise<AsNotesLayout> {
    const root = notesRootOf(files.map((f) => f.path))
    const settings = await readWorkspaceSettings(files, report)
    const journalFolder = cleanFolder(settings['as-notes.journalFolder']) ?? 'journals'
    const templateFolder = cleanFolder(settings['as-notes.templateFolder']) ?? 'templates'

    const inRoot: SourceFile[] = []
    let outside = 0
    for (const file of files) {
        const path = withinRoot(file.path, root)
        if (path !== null) inRoot.push(path === file.path ? file : { path, data: file.data })
        else if (!isJunkPath(file.path)) outside++
    }
    if (outside > 0) {
        report.push({
            category: 'drop',
            detail: `${count(outside, 'file', 'files')} outside the notes folder "${root}" ${outside === 1 ? 'was' : 'were'} not imported`,
        })
    }

    // `.asnotesignore` is a dot-file, so it is read from the unfiltered list.
    const ignoreFile = findFile(inRoot, '.asnotesignore')
    const { rules, skipped } = ignoreFile ? parseIgnoreFile(await readText(ignoreFile)) : { rules: [], skipped: [] }
    if (skipped.length > 0) {
        report.push({
            category: 'unsupported',
            detail: `.asnotesignore patterns that are not a plain folder or file name were not applied, so the files they match were imported: ${skipped.join(', ')}`,
        })
    }

    const publish = await readPublishSetup(inRoot, report)
    const publishOwned = (path: string) =>
        publish.configs.includes(path) || [...publish.setupFolders, ...publish.outputFolders].some((f) => isUnder(path, f))
    if (publish.configs.length > 0 || publish.setupFolders.length > 0) {
        const setup = [...publish.configs, ...publish.setupFolders.map((f) => `${f}/`)].join(', ')
        const sites = publish.outputFolders.map((f) => `${f}/`).join(', ')
        report.push({
            category: 'unsupported',
            detail: sites
                ? `The AS Notes publish setup (${setup}) and the site it generates (${sites}) were not imported. To publish from EtherPK, set up a Publication.`
                : `The AS Notes publish setup (${setup}) was not imported. To publish from EtherPK, set up a Publication.`,
        })
    }

    const content: SourceFile[] = []
    let ignored = 0
    for (const file of inRoot) {
        if (isJunkPath(file.path) || publishOwned(file.path)) continue
        if (isEncryptedNotePath(file.path)) {
            report.push({
                category: 'drop',
                detail: `"${file.path}" is an AS Notes encrypted note, so it was not imported. It is still in the source folder.`,
            })
            continue
        }
        if (rules.some((rule) => ignores(rule, file.path))) {
            ignored++
            continue
        }
        content.push(file)
    }
    if (ignored > 0) {
        report.push({
            category: 'drop',
            detail: `${count(ignored, 'file', 'files')} that .asnotesignore excludes ${ignored === 1 ? 'was' : 'were'} not imported`,
        })
    }

    return { root, journalFolder, templateFolder, files: content }
}
