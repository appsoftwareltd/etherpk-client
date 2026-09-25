/**
 * Parse a document's YAML frontmatter. Frontmatter is authoritative for identity
 * (DESIGN.md → On-disk layout); the rest of the storage layer reads `title`,
 * `aliases`, etc. from `data`.
 *
 * A hand-edited file must never crash the scan, so malformed or unterminated
 * frontmatter degrades to "no frontmatter" (`data: {}`, `body` = the whole text)
 * rather than throwing.
 */

import { parse as parseYaml } from 'yaml'

import { frontmatterSpan } from './frontmatter-span'

export interface ParsedFrontmatter {
    /** The parsed YAML object, or `{}` when there is none / it is malformed. */
    data: Record<string, unknown>
    /** The document text after the frontmatter block (the whole text if none). */
    body: string
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
    // What counts as Frontmatter is decided in one place (frontmatter-span.ts), so the editor's
    // styling, its completion guards and this parse cannot disagree about the same file.
    const span = frontmatterSpan(text)
    if (!span) return { data: {}, body: text }

    const body = text.slice(span.end)
    try {
        const parsed = parseYaml(span.body)
        // YAML can parse to a scalar/array/null; only a plain object is frontmatter.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { data: parsed as Record<string, unknown>, body }
        }
        return { data: {}, body }
    } catch {
        // Malformed YAML in a hand-edited file: treat as no frontmatter.
        return { data: {}, body }
    }
}
