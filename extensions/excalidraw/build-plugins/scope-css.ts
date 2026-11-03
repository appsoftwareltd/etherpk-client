/**
 * A PostCSS plugin that scopes every style rule under an `excalidraw` class, as the EtherPK Client
 * requires of an extension mounted in the page (`"isolation": "page"`). A rule that already
 * styles an element with a class starting with `excalidraw`, or one inside it, is left alone. Any
 * other gets `.excalidraw` put before the element it styles, after any `:root[...]` condition:
 * `.zoom-actions` becomes `.excalidraw .zoom-actions`, and `:root[dir=rtl] .zoom-out-button` becomes
 * `:root[dir=rtl] .excalidraw .zoom-out-button`. `:root` itself, which holds Excalidraw's z-index
 * variables, becomes the elements Excalidraw draws into: its container, its dialogs' containers (which
 * carry the `excalidraw` class) and its tooltips.
 */
import type { Plugin, Rule } from 'postcss'

const OWNED = /\.excalidraw[\w-]*(?![\w-])/

/** Whether a selector already styles an `excalidraw` element or one inside it (the Client's rule, simplified). */
export function ownedSelector(selector: string): boolean {
    return OWNED.test(selector.replace(/\([^)]*\)/g, ''))
}

/** A selector scoped under `.excalidraw`. */
export function scopeSelector(selector: string): string[] {
    const trimmed = selector.trim()
    if (ownedSelector(trimmed)) return [trimmed]
    if (trimmed === ':root' || trimmed === 'html' || trimmed === 'body') return ['.excalidraw', '.excalidraw-tooltip']
    const root = /^(:root(?:\[[^\]]*\])*|html(?:\[[^\]]*\])*)\s+(.*)$/.exec(trimmed)
    if (root) return [`${root[1]} .excalidraw ${root[2]}`]
    return [`.excalidraw ${trimmed}`]
}

export function scopeExcalidrawCss(): Plugin {
    return {
        postcssPlugin: 'etherpk-scope-excalidraw',
        Rule(rule: Rule) {
            // Keyframe steps are not selectors, and nested rules are relative to a scoped parent.
            if (rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as { name: string }).name)) return
            if (rule.parent?.type === 'rule') return
            const scoped = rule.selectors.flatMap(scopeSelector)
            if (scoped.join(',') !== rule.selectors.join(',')) rule.selectors = [...new Set(scoped)]
        },
    }
}
