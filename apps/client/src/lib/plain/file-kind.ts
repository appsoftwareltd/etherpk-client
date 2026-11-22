/**
 * What kind of file a path names, by its extension: which View opens it and which icon the tree
 * draws. The extension is all there is to go on before a file is read. A file that turns out not
 * to be text is caught when it is opened (plain-folder-store.ts, `ReadOnlyReason`).
 */
import { AUDIO_EXTS, VIDEO_EXTS, isImageExt } from '../storage/fs/asset-store'

import { extensionOf } from './plain-path'

export type FileKind = 'markdown' | 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'ebook' | 'binary'

const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd'])
const EBOOK = new Set(['epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'cbz'])
/** Formats that are never text, so opening one in the editor would only show noise. */
const BINARY = new Set([
    'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war',
    'exe', 'dll', 'so', 'dylib', 'bin', 'dmg', 'iso', 'msi', 'deb', 'rpm', 'apk', 'wasm', 'class', 'o', 'a',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'psd', 'ai', 'sketch', 'fig', 'xcf', 'tif', 'tiff', 'heic', 'raw', 'ico', 'icns',
    'sqlite', 'db', 'mdb', 'pyc', 'lock-bin', 'crswap',
    'mov', 'avi', 'mkv', 'wmv', 'flv', 'aac', 'wma', 'aiff', 'mid', 'midi',
])

export function fileKindOf(path: string): FileKind {
    const extension = extensionOf(path)
    if (MARKDOWN.has(extension)) return 'markdown'
    if (isImageExt(extension)) return 'image'
    if ((VIDEO_EXTS as readonly string[]).includes(extension)) return 'video'
    if ((AUDIO_EXTS as readonly string[]).includes(extension)) return 'audio'
    if (extension === 'pdf') return 'pdf'
    if (EBOOK.has(extension)) return 'ebook'
    if (BINARY.has(extension)) return 'binary'
    // Everything else is taken for text: code, configuration, a README with no extension.
    return 'text'
}

/** True for a file the editor opens: markdown, or any other text. */
export function isEditableKind(kind: FileKind): boolean {
    return kind === 'markdown' || kind === 'text'
}

/** The icon the tree and a tab draw for a file, from the Client's icon table. */
export function fileIconOf(path: string): string {
    switch (fileKindOf(path)) {
        case 'markdown':
        case 'text':
            return 'file-text'
        case 'image':
            return 'image'
        case 'pdf':
            return 'pdf'
        case 'ebook':
            return 'book'
        default:
            return 'page'
    }
}
