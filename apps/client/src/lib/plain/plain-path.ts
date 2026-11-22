/**
 * Paths inside a [[Plain Folder]], and the markdown links between its files.
 *
 * A file there is named by its path from the folder's root, with forward slashes and no leading
 * slash (`guide/images/bed.png`); the root itself is the empty path. Nothing here folds case: on
 * Linux `README.md` and `readme.md` are two files. Names are composed (NFC), because macOS can list
 * a name decomposed while the link that names it was typed composed, and the two must meet.
 *
 * Pure, so the store, the tree, link clicks and path completion all read one rule.
 */

/**
 * The path with `.` and empty segments dropped, `..` resolved and names composed. Null when it
 * climbs out of the folder.
 */
export function normalisePath(path: string): string | null {
    const out: string[] = []
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue
        if (part === '..') {
            if (out.length === 0) return null
            out.pop()
            continue
        }
        out.push(part.normalize('NFC'))
    }
    return out.join('/')
}

/** The folder a path sits in: `guide/images` for `guide/images/bed.png`, the root for `README.md`. */
export function dirOf(path: string): string {
    const slash = path.lastIndexOf('/')
    return slash < 0 ? '' : path.slice(0, slash)
}

/** The last segment of a path. */
export function baseName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1)
}

/** The extension in lower case, without its dot. Empty for a name with none, and for a dot-file. */
export function extensionOf(path: string): string {
    const name = baseName(path)
    const dot = name.lastIndexOf('.')
    return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** `name` inside the folder `dir`. */
export function joinPath(dir: string, name: string): string {
    return dir === '' ? name : `${dir}/${name}`
}

/** The directory of `directories` that `path` is in, or is: the outermost when they nest. Null for none. */
export function directoryHolding(directories: readonly string[], path: string): string | null {
    let found: string | null = null
    for (const directory of directories) {
        if ((path === directory || path.startsWith(`${directory}/`)) && (found === null || directory.length < found.length)) found = directory
    }
    return found
}

/** Where a markdown link leads, read from the file that holds it. */
export type LinkTarget =
    /** A file of the folder, and the heading in it the link names, if any. */
    | { kind: 'file'; path: string; fragment: string | null }
    /** A path that climbs out of the folder. */
    | { kind: 'outside' }
    /** An address with a scheme or a host: not a file here. */
    | { kind: 'external' }

/** `https:`, `mailto:` and the like, or `//host`. A Windows drive letter is not one of these in a link. */
const EXTERNAL = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/

/** Percent-decoding that leaves a destination with a stray `%` as it was written. */
function decoded(text: string): string {
    try {
        return decodeURIComponent(text)
    } catch {
        return text
    }
}

/**
 * Resolve the destination of a markdown link held by the file at `from`. A relative destination
 * starts from that file's folder. A leading slash means the root of the Plain Folder, as it does on
 * a repository host. A destination that is only `#heading` names the file itself.
 */
export function resolveLink(from: string, href: string): LinkTarget {
    if (EXTERNAL.test(href)) return { kind: 'external' }
    const hash = href.indexOf('#')
    const fragment = hash < 0 ? null : decoded(href.slice(hash + 1))
    const beforeHash = hash < 0 ? href : href.slice(0, hash)
    const query = beforeHash.indexOf('?')
    const written = query < 0 ? beforeHash : beforeHash.slice(0, query)
    if (written === '') return { kind: 'file', path: from, fragment }
    const base = written.startsWith('/') ? '' : dirOf(from)
    // Decode a segment at a time: an encoded slash (%2F) is part of a name, never a separator.
    const parts = written.split('/').map(decoded)
    const path = normalisePath(joinPath(base, parts.join('/')))
    return path === null ? { kind: 'outside' } : { kind: 'file', path, fragment }
}

/**
 * One path segment as a link destination holds it. Everything a destination could misread is
 * escaped: a space would end it, a bracket could close it, and `#`, `?` and `%` have meanings of
 * their own. Letters of any script are left readable.
 */
function encodeSegment(segment: string): string {
    return segment.replace(/[%#?()[\]<>\\ "'`]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** The shortest relative link from the file at `from` to the file at `to`, escaped for markdown. */
export function relativeLink(from: string, to: string): string {
    const fromDir = dirOf(from) === '' ? [] : dirOf(from).split('/')
    const target = to.split('/')
    let shared = 0
    while (shared < fromDir.length && shared < target.length - 1 && fromDir[shared] === target[shared]) shared++
    const up = fromDir.slice(shared).map(() => '..')
    return [...up, ...target.slice(shared).map(encodeSegment)].join('/')
}

/**
 * The anchor of each heading, in document order, by the rule repository hosts use: lower case,
 * everything but letters, digits, spaces, hyphens and underscores dropped, each space a hyphen. A
 * repeated heading gets `-1`, `-2` and so on.
 */
export function headingSlugs(headings: readonly string[]): string[] {
    const seen = new Map<string, number>()
    return headings.map((heading) => {
        const slug = heading
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
            .replace(/ /g, '-')
        const count = seen.get(slug) ?? 0
        seen.set(slug, count + 1)
        return count === 0 ? slug : `${slug}-${count}`
    })
}
