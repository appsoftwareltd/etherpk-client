/**
 * Line-walk helpers shared by the Logseq and Obsidian converters: fence tracking (fence
 * interiors pass through verbatim - the degradation policy never rewrites code), an
 * inline-code guard, the scoped-concept chain for hierarchies, and frontmatter assembly.
 */

import { stringify as stringifyYaml } from 'yaml'

/**
 * Tracks fenced-code state across a line walk. Call once per line, in order; returns
 * true when the line must pass through verbatim (an opening/closing fence line or any
 * interior line). Tolerates bullet-carried fences (`- ```js`) the way the outliner does.
 */
export function createFenceTracker(): (line: string) => boolean {
    let open: string | null = null
    return (line) => {
        const fence = /^\s*(?:[-*+]\s+)?(`{3,}|~{3,})/.exec(line)
        if (open) {
            if (fence && fence[1][0] === open[0] && fence[1].length >= open.length) open = null
            return true
        }
        if (fence) {
            open = fence[1]
            return true
        }
        return false
    }
}

/**
 * Apply `transform` to the parts of `text` outside inline-code spans (single or double
 * backtick pairs). An unpaired backtick leaves the tail untransformed - the safe side.
 */
export function outsideInlineCode(text: string, transform: (segment: string) => string): string {
    const parts = text.split(/(`+[^`]*`+)/)
    return parts.map((part, i) => (i % 2 === 0 ? transform(part) : part)).join('')
}

/**
 * The scoped-concept name for a hierarchy path (CONTEXT.md → [[Scoped Concept]]):
 * `a/b` → `[[a]] b`, `a/b/c` → `[[[[a]] b]] c` - each level scopes the next, so the
 * parent linkage survives as backlinks.
 */
export function scopedConceptName(segments: string[]): string {
    return segments.reduce((scope, segment) => (scope === '' ? segment : `[[${scope}]] ${segment}`), '')
}

/** Serialize frontmatter (`''` when there is nothing to write). Key order is the caller's. */
export function buildFrontmatter(data: Record<string, unknown>): string {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null)
    if (entries.length === 0) return ''
    return `---\n${stringifyYaml(Object.fromEntries(entries))}---\n`
}

/** Append ` (2)`, ` (3)`... to a concept until `taken` no longer contains its key. */
export function dedupeConcept(concept: string, taken: (key: string) => boolean): string {
    if (!taken(concept.toLowerCase())) return concept
    for (let n = 2; ; n++) {
        const candidate = `${concept} (${n})`
        if (!taken(candidate.toLowerCase())) return candidate
    }
}
