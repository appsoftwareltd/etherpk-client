/**
 * AS Notes's own reading of a Frontmatter block, for a block YAML rejects.
 *
 * AS Notes reads frontmatter line by line: each top-level `key: value` line is one property, the
 * value is the rest of the line, and an `aliases:` with no value takes the indented `- item`
 * lines under it. So `title: Plans: 2026` is a title to AS Notes and an error to YAML. Reading
 * such a block the same way and writing it back as valid YAML keeps every property AS Notes saw.
 *
 * A line AS Notes would skip (a nested mapping, a multi-line value) means the block holds
 * something AS Notes never read either, so the block is not rewritten at all: the caller keeps it
 * as written, which loses nothing.
 */

/** The keys AS Notes reads as true or false, accepting `yes` and `no` as well. */
const BOOLEAN_KEYS = new Set(['public', 'assets', 'retina', 'draft'])

const KEY_VALUE = /^(\w[\w-]*)\s*:\s*(.*)$/
const LIST_ITEM = /^\s+-\s+(.*)$/

/** A value with one pair of surrounding quotes removed. */
function unquote(value: string): string {
    return /^(["']).*\1$/.test(value) && value.length >= 2 ? value.slice(1, -1) : value
}

/** `[a, "b"]` as a list, the way AS Notes splits it: at every comma, quotes removed. */
function inlineList(value: string): string[] {
    const inner = value.replace(/^\[/, '').replace(/\]$/, '').trim()
    return inner === '' ? [] : inner.split(',').map((item) => unquote(item.trim())).filter((item) => item !== '')
}

function scalar(key: string, raw: string): unknown {
    const value = unquote(raw)
    if (BOOLEAN_KEYS.has(key.toLowerCase())) {
        const lower = value.toLowerCase()
        if (lower === 'true' || lower === 'yes') return true
        if (lower === 'false' || lower === 'no') return false
    }
    if (raw === value && /^-?\d+$/.test(value)) return Number(value)
    return value
}

/**
 * The block's properties as AS Notes reads them, or null when a line is one AS Notes skips.
 * `yaml` is the text between the delimiters.
 */
export function readAsNotesFrontmatter(yaml: string): Record<string, unknown> | null {
    const data: Record<string, unknown> = {}
    const lines = yaml.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue
        const match = KEY_VALUE.exec(line)
        if (!match) return null
        const [, key, rawValue] = match
        const value = rawValue.trim()
        if (value.startsWith('[')) {
            data[key] = inlineList(value)
        } else if (value !== '') {
            data[key] = scalar(key, value)
        } else {
            // An empty value takes the indented list items under it, as AS Notes reads `aliases:`.
            const items: string[] = []
            while (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
                items.push(unquote(LIST_ITEM.exec(lines[++i])![1].trim()))
            }
            data[key] = items.length > 0 ? items : null
        }
    }
    return data
}
