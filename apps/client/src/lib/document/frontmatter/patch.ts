/**
 * Rewriting arbitrary keys of a document's [[Frontmatter]] block, the way `withFrontmatterIdentity`
 * rewrites identity: other keys keep their values and order, the same string comes back when
 * nothing would change, and a block whose YAML does not parse is left alone rather than
 * destroyed. `null` removes a key. A block emptied of every key is removed with it. Identity keys
 * are not this function's business: pass them through `withFrontmatterIdentity` so the registry
 * rules (ADR 0061) apply.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

export type FrontmatterPatch = Readonly<Record<string, unknown>>

function parseBlock(yaml: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = parseYaml(yaml)
        if (parsed === null || parsed === undefined) return {}
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return parsed as Record<string, unknown>
    } catch {
        return null
    }
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

export function withFrontmatterPatch(text: string, patch: FrontmatterPatch, options: { addBlock?: boolean } = {}): string {
    const span = frontmatterSpan(text)
    if (!span) {
        if (!options.addBlock) return text
        const data: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(patch)) if (value !== null && value !== undefined) data[key] = value
        if (Object.keys(data).length === 0) return text
        return `---\n${stringifyYaml(data)}---\n${text}`
    }
    const data = parseBlock(span.body)
    if (data === null) return text
    const next: Record<string, unknown> = {}
    let changed = false
    for (const [key, value] of Object.entries(data)) {
        if (key in patch) {
            const wanted = patch[key]
            if (wanted === null || wanted === undefined) {
                changed = true
                continue
            }
            next[key] = wanted
            if (!same(wanted, value)) changed = true
            continue
        }
        next[key] = value
    }
    for (const [key, value] of Object.entries(patch)) {
        if (key in data || value === null || value === undefined) continue
        next[key] = value
        changed = true
    }
    if (!changed) return text
    if (Object.keys(next).length === 0) return text.slice(span.end)
    return `---\n${stringifyYaml(next)}---\n${text.slice(span.end)}`
}
