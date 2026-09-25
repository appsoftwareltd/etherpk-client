/**
 * The asset file-name rule on its own, with no imports behind it: the Demo Graph bundle check
 * (demo-graph-plugin.ts) runs in the Vite config process, where `$lib` does not resolve, and
 * needs to read the content hash out of a committed asset name exactly as the store does.
 */

/**
 * A name this store wrote, read back: `<slug>.<hash>` or `<slug>.<hash>.<ext>`. `publishSlug`
 * keeps only `[a-z0-9-]`, so the slug can never contain a dot and the segments are unambiguous —
 * a two-segment name is the extension-less form, a three-segment one carries the extension last.
 *
 * This is what makes de-duplication work on **content** rather than on the whole file name: the
 * store reads the hash back out of the files already in `assets/` (see {@link createAssetStore}).
 * `null` for anything else, including a file the user dropped in by hand.
 */
export function assetHashFromName(fileName: string): { hash: string; ext: string } | null {
    const match = /^(.+)\.([0-9a-f]{8})(?:\.([^.]+))?$/.exec(fileName)
    if (!match || match[1].includes('.')) return null
    return { hash: match[2], ext: (match[3] ?? '').toLowerCase() }
}

/**
 * Whether a decoded asset name is one file inside `assets/`, and so safe to join onto a folder.
 *
 * An asset reference comes from a document, and a document can come from a collaborator, an
 * import or an agent, so the name it decodes to is untrusted: `../assets/..%2Fpages%2FSecret.md`
 * decodes to a path that leaves `assets/`. Every place that turns a reference into a file path
 * (the asset stores, the publisher's bundle) checks this first, before any directory adapter
 * or site writer sees the name.
 */
export function isSafeAssetName(name: string): boolean {
    if (!isSingleFileName(name)) return false
    // Control characters (NUL included) have no place in a file name and mean different things
    // to different filesystems.
    for (const char of name) {
        const code = char.codePointAt(0) ?? 0
        if (code < 0x20 || code === 0x7f) return false
    }
    return true
}

/**
 * Whether `name` is one entry of a directory rather than a path: not empty, not `.` or `..`, and
 * free of separators and NUL. What a directory adapter requires of every name it is handed, which
 * is looser than {@link isSafeAssetName}: a file already on disk may carry other odd characters.
 */
export function isSingleFileName(name: string): boolean {
    if (name === '' || name === '.' || name === '..') return false
    return !name.includes('/') && !name.includes('\\') && !name.includes('\u0000')
}
