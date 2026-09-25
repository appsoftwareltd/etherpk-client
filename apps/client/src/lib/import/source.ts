/**
 * Source-folder plumbing: path normalisation and the junk filter. The wizard reads a
 * `webkitdirectory` FileList into {@link SourceFile}s; converters then see only content
 * files - config dirs (`.obsidian/`, `logseq/`) are read separately by their own
 * converter, never treated as content.
 */

import { detectFormat } from './detect'
import type { ImportFormat, SourceFile } from './types'

/** Root-level directories that are configuration, not content. */
const CONFIG_ROOT_DIRS = new Set(['logseq'])

/** Directory / file segments that are junk anywhere in the tree. */
const JUNK_SEGMENTS = new Set(['node_modules', '__MACOSX'])

/**
 * `webkitRelativePath` starts with the picked folder's own name; converters work in
 * root-relative paths, so strip that first segment.
 */
export function stripRootSegment(path: string): string {
    const slash = path.indexOf('/')
    return slash === -1 ? path : path.slice(slash + 1)
}

/**
 * True for files excluded from content: anything under a dot-directory (`.obsidian/`,
 * `.git/`, `.trash/`), dot-files themselves (`.DS_Store`, `.gitignore`), `node_modules/`,
 * and the root `logseq/` config dir. Config readers go to the raw list, not through this.
 */
export function isJunkPath(path: string): boolean {
    const segments = path.split('/')
    if (segments.some((s) => s.startsWith('.') || JUNK_SEGMENTS.has(s))) return true
    return segments.length > 1 && CONFIG_ROOT_DIRS.has(segments[0])
}

/** The content files of a source: everything the junk filter lets through. */
export function contentFiles(files: SourceFile[]): SourceFile[] {
    return files.filter((f) => !isJunkPath(f.path))
}

/** A source as the wizard shows it: the files, the name prefill, the detected format and the counts. */
export interface SourceSummary {
    files: SourceFile[]
    /** The picked folder's own name, or the zip's single top-level folder - the name prefill. */
    folderName: string
    format: ImportFormat
    markdownCount: number
    otherCount: number
}

/** Detect the format and count what the junk filter lets through. */
export function describeSource(files: SourceFile[], folderName: string): SourceSummary {
    const content = contentFiles(files)
    return {
        files,
        folderName,
        format: detectFormat(files.map((f) => f.path)),
        markdownCount: content.filter((f) => isMarkdownPath(f.path)).length,
        otherCount: content.filter((f) => !isMarkdownPath(f.path)).length,
    }
}

/** Case-insensitive `.md` check. */
export function isMarkdownPath(path: string): boolean {
    return /\.md$/i.test(path)
}

/** The file name (last path segment). */
export function baseName(path: string): string {
    const slash = path.lastIndexOf('/')
    return slash === -1 ? path : path.slice(slash + 1)
}

/** The directory part of a path (`''` for a root-level file). */
export function dirName(path: string): string {
    const slash = path.lastIndexOf('/')
    return slash === -1 ? '' : path.slice(0, slash)
}

/** Find one file by exact path, or `null`. */
export function findFile(files: SourceFile[], path: string): SourceFile | null {
    return files.find((f) => f.path === path) ?? null
}

/** Read a source file's text (converters call this for markdown/config only). */
export async function readText(file: SourceFile): Promise<string> {
    return file.data.text()
}
