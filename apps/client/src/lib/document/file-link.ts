/**
 * A [[File Link]]'s target: a `file:` url, and the path it names in the form the reader would
 * type on their own machine (CONTEXT.md → File Link).
 *
 * A page served from the web cannot open a `file:` url, so the path is what a file link is
 * *for*: it is what a click copies, and what the copy icon names. Nothing here checks that the
 * file exists, and nothing ever hands the url to the browser (`safeHref` in
 * `markdown-link-core.ts` still refuses the scheme).
 *
 * The native form: percent-escapes decoded; a drive letter turns the path into its Windows
 * spelling, in both the correct `file:///C:/x` and the loose `file://C:/x` that Windows tools
 * and people both write; a host other than `localhost` is a UNC share, `\\server\share\x`.
 * A url with nothing after the scheme names no file and is not a link.
 */

const FILE_SCHEME = /^file:\/\//i

/** Whether `target` carries the `file:` scheme. The scheme test alone; the path may still be empty. */
export function isFileUrl(target: string): boolean {
    return FILE_SCHEME.test(target.trim())
}

/** Percent-decode, keeping the text as written when it is not valid percent-encoding. */
function decode(text: string): string {
    try {
        return decodeURIComponent(text)
    } catch {
        return text
    }
}

/** The native path a `file:` url names, or null when it is not a file url or names no file. */
export function fileLinkPath(target: string): string | null {
    const url = target.trim()
    if (!FILE_SCHEME.test(url)) return null
    const rest = url.slice('file://'.length)
    const slash = rest.indexOf('/')
    let host = slash < 0 ? rest : rest.slice(0, slash)
    let path = slash < 0 ? '' : rest.slice(slash)
    // The loose drive-as-host spelling: `file://C:/x`.
    if (/^[a-z]:$/i.test(host)) {
        path = `/${host}${path}`
        host = ''
    }
    if (host && host.toLowerCase() !== 'localhost') {
        // A host names a UNC share: `file://server/share/x` is `\\server\share\x`. A bare host is no file.
        if (path.length <= 1) return null
        return `\\\\${host}${decode(path).replace(/\//g, '\\')}`
    }
    const decoded = decode(path)
    const drive = /^\/([a-z]:)(.*)$/i.exec(decoded)
    if (drive) {
        const tail = drive[2].replace(/\//g, '\\')
        return `${drive[1]}${tail || '\\'}`
    }
    // `/` alone is the root of the filesystem, not a file anyone links to.
    return decoded.length > 1 ? decoded : null
}
