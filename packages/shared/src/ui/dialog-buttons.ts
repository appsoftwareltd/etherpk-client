/**
 * Find `<button>` tags inside a dialog that do not declare a `type`.
 *
 * Inside a `<form>`, a `<button>` with no `type` IS a submit button. `Dialog.svelte` wraps every
 * dialog body and footer in a real form so Enter runs the primary action, which turns that HTML
 * default into a trap: an untyped button anywhere in a dialog silently fires the dialog's
 * primary action as well as its own handler.
 *
 * It bit once. `OrphanAssetsSection` renders inside the Graph Settings dialog, and its untyped
 * "Scan for orphaned assets" button started saving the settings and closing the dialog instead
 * of scanning (2026-08-30).
 *
 * There is no linter in this repository, so the two `dialog-button-type.test.ts` suites use this
 * to stand in for the rule one would enforce.
 */

/** Anything between `{#snippet body()}` / `{#snippet footer()}` and its matching `{/snippet}`. */
function dialogSnippetRanges(source: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = []
    for (const open of source.matchAll(/\{#snippet\s+(?:body|footer)\s*\(\s*\)\s*\}/g)) {
        const from = open.index + open[0].length
        // Snippets can nest, so walk forward counting opens against closes.
        let depth = 1
        let cursor = from
        while (depth > 0) {
            const next = /\{#snippet\b|\{\/snippet\}/g
            next.lastIndex = cursor
            const token = next.exec(source)
            if (!token) return [...ranges, [from, source.length]]
            depth += token[0] === '{/snippet}' ? -1 : 1
            cursor = token.index + token[0].length
        }
        ranges.push([from, cursor])
    }
    return ranges
}

/** Blank out HTML and block comments so a `<button>` written in prose is not a finding. */
function withoutComments(source: string): string {
    return source
        .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
        .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
}

/**
 * The 1-indexed lines of every untyped `<button>` that sits inside a dialog snippet.
 *
 * A component with no dialog snippets is scanned in full: it may be rendered *into* someone
 * else's dialog, which is exactly how the orphan-assets regression happened.
 */
export function untypedDialogButtons(source: string, opts: { wholeFile?: boolean } = {}): number[] {
    const scannable = withoutComments(source)
    const ranges = opts.wholeFile ? [[0, scannable.length] as [number, number]] : dialogSnippetRanges(scannable)
    if (ranges.length === 0) return []

    const lines: number[] = []
    for (const match of scannable.matchAll(/<button\b([^>]*)>/g)) {
        if (/\btype=/.test(match[1])) continue
        if (!ranges.some(([from, to]) => match.index >= from && match.index < to)) continue
        lines.push(scannable.slice(0, match.index).split('\n').length)
    }
    return lines
}
