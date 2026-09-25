/**
 * The two derivations from a concept (the link's identity yields neither itself —
 * see ADR 0011). `onDiskName` is a storage convenience; `publishSlug` is the URL
 * name. Both are pure.
 */

/** Characters illegal in a file name on common filesystems (the AS Notes set). */
const INVALID_FILE_CHARS = /[/?<>\\:*|"]/g

/**
 * The on-disk file name for a concept (sans extension). Scoped concepts keep their
 * inner `[ ]` brackets; only filesystem-illegal characters are replaced with `_`.
 * A derived convenience only — frontmatter is authoritative for identity (ADR 0007).
 */
export function onDiskName(concept: string): string {
    return concept.replace(INVALID_FILE_CHARS, '_')
}

/** Control characters: illegal or meaningless in a file name, and invisible if kept. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** Names Windows reserves for devices, with or without an extension (case-insensitive). */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * Longest stem written, in UTF-8 bytes. Common filesystems cap a name at 255 bytes, and the
 * mirror may add a ` (10).md` suffix to it, so this leaves room for both.
 */
const MAX_STEM_BYTES = 200

/** `value` cut to at most `maxBytes` of UTF-8, never splitting a code point. */
function truncateToBytes(value: string, maxBytes: number): string {
    if (value.length <= maxBytes / 4) return value
    const encoder = new TextEncoder()
    if (encoder.encode(value).length <= maxBytes) return value
    let out = ''
    let bytes = 0
    for (const codePoint of value) {
        const size = encoder.encode(codePoint).length
        if (bytes + size > maxBytes) break
        out += codePoint
        bytes += size
    }
    return out
}

/**
 * {@link onDiskName} hardened for a directory that may be carried between operating systems by
 * the user's own sync tool or version control - which is the [[Local Mirror]]'s whole purpose,
 * and true of an exported Filesystem Backend folder too.
 *
 * Beyond the illegal-character set: control characters go, Windows silently drops trailing dots
 * and spaces (so a name written here would not be the name read back), its reserved device names
 * cannot be files at all, and a very long concept would exceed the byte cap every common
 * filesystem enforces. A concept that empties out, or lands on another concept's stem (`etc` and
 * `etc.`, `A/B` and `A_B`, two titles that truncate alike), is not a loss: identity is the
 * frontmatter `title` (ADR 0007, ADR 0061), and the file name is disambiguated by the allocators -
 * `allocateFileName` in `storage/fs/filesystem-store.ts` for the Filesystem Backend and
 * `planMirrorNames` in `storage/server/mirror-names.ts` for the Local Mirror - which suffix it
 * ` (2)`, ` (3)`, ... by the rule in `storage/file-names.ts`. Never write a stem from here to
 * disk without one of them.
 */
export function portableFileStem(concept: string): string {
    const sanitised = onDiskName(concept).replace(CONTROL_CHARS, '_')
    // A leading dot makes a hidden file on Unix, and the import's junk filter skips dot-files,
    // so a page titled `.profile` would leave the folder and never come back.
    const trimmed = truncateToBytes(sanitised, MAX_STEM_BYTES)
        .replace(/[. ]+$/, '')
        .replace(/^\./, '_')
    if (trimmed === '') return '_'
    return RESERVED_DEVICE_NAME.test(trimmed) ? `${trimmed}_` : trimmed
}

/**
 * The publish Slug for a concept: lowercase; spaces and underscores to hyphens;
 * drop anything not `[a-z0-9-]`; collapse and trim hyphens (DESIGN.md → Publishing).
 * (A document with a `title` frontmatter slugs its title instead — that is the
 * caller's concern; this slugs a raw concept/name.)
 */
export function publishSlug(concept: string): string {
    return concept
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
}
