/**
 * A document's [[Property]]s as the [[Derived Index]] holds them: one row per value, so a
 * [[Property Filter]] in [[Search]] is a lookup rather than a parse of every document (ADR 0107).
 *
 * Pure and framework-free: the stores call it on the parsed Frontmatter when they build a
 * document's index snapshot, and the index writes the rows it returns.
 */

/** One row: a key as written (a dot path for a nested value) and the value as text. */
export interface IndexProperty {
    key: string
    /**
     * The value as text, or null for a mapping that holds at least one set value. A null row
     * lets `publication:*` find a page whose `publication:` is a mapping, while a value filter
     * never matches it.
     */
    value: string | null
}

/**
 * Keys a Property Filter answers from the graph's names rather than the block: the registry on
 * a Server Backend holds them, and a page created in the app there has no block to read.
 */
export const NAME_PROPERTY_KEYS: ReadonlySet<string> = new Set(['title', 'aliases'])

/** Rows per document at most. Frontmatter is metadata; a block past this is not a label set. */
const MAX_ROWS = 256

/** Characters of one value kept. Longer text is prose, which Search's text group covers. */
const MAX_VALUE_LENGTH = 1000

/**
 * Whether a value counts as not set (ADR 0108): null, blank text, a list with no set item, or a
 * mapping with no set value. `false` and `0` are values.
 */
export function isEmptyPropertyValue(value: unknown): boolean {
    if (value === null || value === undefined) return true
    if (typeof value === 'string') return value.trim() === ''
    if (Array.isArray(value)) return value.every(isEmptyPropertyValue)
    if (isMapping(value)) return Object.values(value).every(isEmptyPropertyValue)
    return false
}

/**
 * The rows for one document's parsed Frontmatter, in the block's order. Empty values are left
 * out, and so are `title` and `aliases` in any spelling: those filters read the graph's names.
 */
export function propertiesOf(data: Readonly<Record<string, unknown>>): IndexProperty[] {
    const out: IndexProperty[] = []
    for (const [key, value] of Object.entries(data)) {
        if (NAME_PROPERTY_KEYS.has(key.toLowerCase())) continue
        collect(key, value, out)
        if (out.length >= MAX_ROWS) break
    }
    return out.slice(0, MAX_ROWS)
}

/** Append the rows for `value` under `path`; a mapping adds its presence row before its values. */
function collect(path: string, value: unknown, out: IndexProperty[]): void {
    if (isEmptyPropertyValue(value)) return
    if (Array.isArray(value)) {
        // A list is its items under the list's own key: `tags:a` matches `tags: [a, b]`. A list
        // of mappings shares one presence row rather than one per item.
        let presence = false
        for (const item of value) {
            if (isMapping(item)) {
                if (!presence && !isEmptyPropertyValue(item)) {
                    out.push({ key: path, value: null })
                    presence = true
                }
                for (const [key, child] of Object.entries(item)) collect(`${path}.${key}`, child, out)
            } else {
                collect(path, item, out)
            }
        }
        return
    }
    if (isMapping(value)) {
        out.push({ key: path, value: null })
        for (const [key, child] of Object.entries(value)) collect(`${path}.${key}`, child, out)
        return
    }
    out.push({ key: path, value: textOf(value).slice(0, MAX_VALUE_LENGTH) })
}

function isMapping(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

/** A scalar as the text a person would type to find it. */
function textOf(value: unknown): string {
    if (value instanceof Date) {
        const iso = value.toISOString()
        // A bare `2026-09-28` parses to midnight UTC under the YAML 1.1 schema; show the day.
        return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
    }
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    return JSON.stringify(value) ?? ''
}
