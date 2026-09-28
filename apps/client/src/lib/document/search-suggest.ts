/**
 * The suggestion list under [[Search]]'s box while a [[Property Filter]] is typed (ADR 0107):
 * the keys the graph uses while a bare word is typed, and the values a key has after its colon.
 *
 * Pure, so the rules are tested without a DOM; the modal owns the list's focus and keys.
 */

import type { PropertyKeyInfo, PropertyValueInfo } from './index-db'
import { PROPERTY_KEY_PATTERN, searchTokens } from './search-query'

/** Where the caret is: typing a key, or typing a known key's value. `from`/`to` span the term. */
export type SuggestionContext =
    | { kind: 'key'; from: number; to: number; prefix: string; negated: boolean }
    | { kind: 'value'; from: number; to: number; key: string; prefix: string; negated: boolean }

/** One row of the list: a key, or a value of the key being typed, with how many documents have it. */
export interface SearchSuggestion {
    kind: 'key' | 'value'
    text: string
    documents: number
}

/** Rows the list shows at most. */
export const SUGGESTION_LIMIT = 8

/**
 * What the caret is in the middle of, or null when there is nothing to suggest: between terms, in
 * a quoted phrase, or after a key no document uses (`http://…` stays text).
 */
export function suggestionContext(input: string, caret: number, knownKeys: ReadonlySet<string>): SuggestionContext | null {
    const token = searchTokens(input).find((t) => t.from < caret && caret <= t.to)
    if (!token) return null
    const before = token.text.slice(0, caret - token.from)
    if (before.startsWith('"')) return null
    const negated = before.startsWith('-')
    const colon = before.indexOf(':')
    if (colon === -1) {
        const prefix = negated ? before.slice(1) : before
        if (!PROPERTY_KEY_PATTERN.test(prefix)) return null
        return { kind: 'key', from: token.from, to: token.to, prefix, negated }
    }
    const key = before.slice(negated ? 1 : 0, colon)
    if (!PROPERTY_KEY_PATTERN.test(key) || !knownKeys.has(key.toLowerCase())) return null
    const raw = before.slice(colon + 1)
    return { kind: 'value', from: token.from, to: token.to, key, prefix: raw.startsWith('"') ? raw.slice(1) : raw, negated }
}

/** Keys that start with what was typed, ignoring case, in each spelling, most used first. */
export function keySuggestions(context: Extract<SuggestionContext, { kind: 'key' }>, keys: readonly PropertyKeyInfo[]): SearchSuggestion[] {
    const prefix = context.prefix.toLowerCase()
    return keys
        .filter((info) => info.key.toLowerCase().startsWith(prefix))
        .slice(0, SUGGESTION_LIMIT)
        .map((info) => ({ kind: 'key', text: info.key, documents: info.documents }))
}

/** A key's values that start with what was typed, ignoring case, most used first. */
export function valueSuggestions(context: Extract<SuggestionContext, { kind: 'value' }>, values: readonly PropertyValueInfo[]): SearchSuggestion[] {
    const prefix = context.prefix.toLowerCase()
    return values
        .filter((info) => info.value.toLowerCase().startsWith(prefix))
        .slice(0, SUGGESTION_LIMIT)
        .map((info) => ({ kind: 'value', text: info.value, documents: info.documents }))
}

/**
 * The box's text with the term at the caret replaced by the suggestion, and where the caret
 * goes. A key gets its colon, caret after it, so the value list opens next. A value is quoted
 * when it holds a space, and the caret moves past it and one space, ready for the next term.
 */
export function applySearchSuggestion(input: string, context: SuggestionContext, suggestion: SearchSuggestion): { value: string; caret: number } {
    const sign = context.negated ? '-' : ''
    const head = input.slice(0, context.from)
    const tail = input.slice(context.to)
    if (suggestion.kind === 'key') {
        const term = `${sign}${suggestion.text}:`
        return { value: `${head}${term}${tail}`, caret: head.length + term.length }
    }
    const key = context.kind === 'value' ? context.key : suggestion.text
    // The filter grammar has no escape inside quotes, so a quote in a value cannot be typed.
    const value = /[\s"]/.test(suggestion.text) ? `"${suggestion.text.replace(/"/g, '')}"` : suggestion.text
    const term = `${sign}${key}:${value}`
    const gap = /^\s/.test(tail) ? '' : ' '
    return { value: `${head}${term}${gap}${tail}`, caret: head.length + term.length + 1 }
}
