/**
 * Augmentation: mark every [[Asset Reference]] that is not a rendered image
 * (`[report](../assets/q3.pdf)`) with `.cm-asset-link`, and follow it with the shared action
 * cluster — download, open in a tab where a viewer is registered, delete. A plain click on the
 * link itself opens a PDF in its tab and downloads anything else; holding the mod key (Ctrl / ⌘)
 * places the caret instead, which is how the link text is edited (the same rule as the wikilink
 * augmentation).
 *
 * **Which references are ours** is the one subtle part. Image syntax over an image target
 * (`![alt](…png)`) belongs to {@link imageEmbedAugmentation} — but only when the embed will
 * actually render it, which it does for a line whose *entire* content is that image (standalone
 * or a bullet's sole content). An image written inside prose — `see ![chart](…png) here` — is
 * rendered by nothing: it used to fall through the embed, through this, and through the
 * markdown-link augmentation, and appear as raw markdown with no affordance at all. It is ours,
 * and it gets the same cluster as every other reference. (`markdown-link-core.ts` needs no
 * matching change: it already skips any asset target outright.)
 *
 * The actions are [[Command]]s, so what a button does and what the [[Context Menu]] does cannot
 * drift apart — see `asset-actions.ts`.
 */

import { type EditorState, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

import { type AssetStore, assetNameFromRef, displayNameForRef } from '#lib/storage/fs/asset-store.js'
import { type AssetContextMenuTarget, openContextMenu, tryGetActiveCommandRegistry } from '#lib/surface/index.js'

import { assetClickCommand, assetExtension, assetExtensionAction, runAssetCommand } from '../../asset-affordances'

import { editorDocument } from '../editor-document'
import { assetTargetAt, attachAssetContextMenu, buildAssetActions } from './asset-actions'
import { parseImageDisplaySizeHint } from './image-display-size'
import { hiddenSyntax, hiddenSyntaxPlugin, type HiddenSyntaxSpec } from './base-renderer'
import { actionClusterTheme } from './inline-actions'
import { isImageTarget } from './image-target'
import { analysisFor } from '../analysis/editor-analysis'
import { isImageLine } from '../../image-line'
import { isInCode } from '../../wikilink/code-ranges'
import { markdownLinks } from '../../markdown-link-target'

export interface AssetLinkOptions {
    /** The active asset store, or `null` when no graph is open. */
    store: () => AssetStore | null
}

/**
 * The Asset a link's element or cluster names. A link with a label over a soft line break has no
 * reference on any one line, which is all {@link assetTargetAt} searches, so it answers from the
 * span. Removing such a link finds no reference on its line, and so does nothing and destroys nothing.
 */
function assetLinkTarget(view: EditorView, el: HTMLElement, ref: string, anchor: 'start' | 'end'): AssetContextMenuTarget | null {
    const found = assetTargetAt(view, el, ref, anchor)
    if (found) return found
    let pos: number
    try {
        pos = view.posAtDOM(el)
    } catch {
        return null
    }
    const span = assetLinkSpans(view.state).find((s) => s.target === ref && s.from <= pos && pos <= s.to)
    return span ? { kind: 'asset', ref, line: view.state.doc.lineAt(pos).number, occurrence: 0, concept: view.state.facet(editorDocument)?.concept } : null
}

/** The trailing icon cluster. Always visible — there is no hover on touch, and this is the only
 *  affordance a link has. The theme keeps it quiet until the pointer is near. */
class AssetActionsWidget extends WidgetType {
    constructor(readonly ref: string) {
        super()
    }

    eq(other: AssetActionsWidget): boolean {
        return other.ref === this.ref
    }

    toDOM(view: EditorView): HTMLElement {
        const resolve = () => assetLinkTarget(view, wrap, this.ref, 'end')
        const wrap = buildAssetActions(view, this.ref, resolve, { className: 'cm-asset-actions', size: 16 })
        attachAssetContextMenu(view, wrap, resolve)
        return wrap
    }

    ignoreEvent(): boolean {
        return true // the cluster's own listeners handle everything; keep CodeMirror out of it
    }
}

/**
 * The file's extension, ahead of the actions. Off the caret's line a link reads as its label, which
 * leaves nothing else to say what kind of file it is, and the pill stays on the caret's line too so
 * the text does not shift as the source shows. Outside the actions because they fade with opacity,
 * and this has to stay readable.
 */
class AssetExtensionWidget extends WidgetType {
    constructor(
        readonly ref: string,
        readonly extension: string,
    ) {
        super()
    }

    eq(other: AssetExtensionWidget): boolean {
        return other.ref === this.ref
    }

    toDOM(view: EditorView): HTMLElement {
        const action = assetExtensionAction(this.ref)
        const pill: HTMLElement = document.createElement(action ? 'button' : 'span')
        pill.className = 'cm-asset-extension'
        pill.textContent = this.extension
        const resolve = () => assetLinkTarget(view, pill, this.ref, 'end')
        attachAssetContextMenu(view, pill, resolve)
        if (!action) return pill
        pill.setAttribute('type', 'button')
        pill.setAttribute('title', action)
        pill.setAttribute('aria-label', `${action} ${displayNameForRef(this.ref)}`)
        // mousedown, as the link and the actions take it, before the editor would place the caret.
        pill.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            const target = resolve()
            if (!target) return
            view.focus()
            void runAssetCommand(assetClickCommand(this.ref), target)
        })
        return pill
    }

    ignoreEvent(): boolean {
        return true
    }
}

/** One asset link this augmentation renders: the whole `[label](target)`, its target and its shape. */
export interface AssetLinkSpan {
    from: number
    to: number
    target: string
    /** `!` or empty. */
    bang: string
    label: string
}

const spansByDoc = new WeakMap<Text, readonly AssetLinkSpan[]>()

/**
 * The asset links in a document, the ones this augmentation owns: a markdown link whose target
 * names an [[Asset]], outside code, and not an image the embed renders on a line of its own.
 * Exported for [[Spell Check]], which leaves them alone because their right-click menu is ours.
 *
 * Memoised on the document text: both callers ask once per document change, and the scan is
 * over the whole document.
 */
export function assetLinkSpans(state: EditorState): readonly AssetLinkSpan[] {
    const cached = spansByDoc.get(state.doc)
    if (cached) return cached
    const spans: AssetLinkSpan[] = []
    const { codeRanges, frontmatterEnd } = analysisFor(state)
    const text = state.doc.toString()
    for (const link of markdownLinks(text)) {
        const { from, to, target } = link
        if (from <= frontmatterEnd) continue // frontmatter is data, not a line of the document
        if (isInCode(codeRanges, from, to)) continue // code is opaque
        if (isEscaped(text, from)) continue // `\[` is a bracket, not a link
        if (assetNameFromRef(target) === null) continue // not an asset reference
        // An image the embed renders is the embed's; an image the embed leaves alone (written
        // inside prose, where the line holds more than the image) is ours.
        if (link.bang === '!' && isImageTarget(target) && isImageLine(state.doc.lineAt(from).text)) continue
        spans.push({ from, to, target, bang: link.bang, label: link.label })
    }
    spansByDoc.set(state.doc, spans)
    return spans
}

/** An odd run of backslashes before `at` escapes what is there. */
function isEscaped(text: string, at: number): boolean {
    let run = 0
    while (at - run - 1 >= 0 && text[at - run - 1] === '\\') run++
    return run % 2 === 1
}

/**
 * The label a link reads as off the caret's line, as an offset range into its source, or null when it
 * stays as written. An image's label carries a display-size hint, which is a rendering instruction
 * (`inline-parts.ts` drops it too). A blank label would leave nothing to read or click, and a
 * `[[Garden]](…)` would lose the wikilink's own brackets.
 */
function shownLabel(span: AssetLinkSpan): { from: number; to: number } | null {
    const { bang, label } = span
    const shown = bang === '!' ? parseImageDisplaySizeHint(label).cleanAlt : label
    if (shown.trim() === '' || /^\[.*\]$/s.test(label)) return null
    const start = bang.length + 1
    return { from: start, to: start + shown.length }
}

/** What hides of a link off the caret's line: everything of its source but the label. */
export function assetLinkHiddenRanges(_state: EditorState, span: AssetLinkSpan): { from: number; to: number }[] {
    const label = shownLabel(span)
    if (!label) return []
    return [
        { from: span.from, to: span.from + label.from },
        { from: span.from + label.to, to: span.to },
    ]
}

/**
 * Asset links as a declaration over the base renderer: a mark, the action cluster after, and the source
 * hidden off the caret. Block-kind reveal (reveal-policy.ts), since a label can run over a soft line
 * break, and the caret on any of its lines shows the whole link's source.
 */
export const assetLinkSpec: HiddenSyntaxSpec = {
    pieces(state, from, to, reveal) {
        const pieces: Range<Decoration>[] = []
        for (const span of assetLinkSpans(state)) {
            if (span.from < from || span.from > to) continue
            const hidden = reveal.blockRevealedAt(span.from, span.to) ? [] : assetLinkHiddenRanges(state, span)
            // The mark covers what shows. A click beside the label reads this to stay outside the link.
            const markFrom = hidden.length > 0 ? hidden[0].to : span.from
            const markTo = hidden.length > 0 ? hidden[1].from : span.to
            const extension = assetExtension(span.target)
            pieces.push(
                Decoration.mark({ class: 'cm-asset-link', attributes: { 'data-augmentation': 'asset-link', 'data-href': span.target } }).range(markFrom, markTo),
                ...hidden.map((range) => hiddenSyntax.range(range.from, range.to)),
                ...(extension ? [Decoration.widget({ widget: new AssetExtensionWidget(span.target, extension), side: 1 }).range(span.to)] : []),
                Decoration.widget({ widget: new AssetActionsWidget(span.target), side: 2 }).range(span.to),
            )
        }
        return pieces
    },
}

export function assetLinkAugmentation(options: AssetLinkOptions): Extension {
    const plugin = hiddenSyntaxPlugin(assetLinkSpec)

    // A plain click opens a PDF and downloads anything else; the mod key suppresses it, leaving the
    // click to place the caret and start a selection inside the link text (the wikilink /
    // markdown-link rule). Taken on
    // `mousedown`, before the caret moves. Routed through the Command so the click, the icon
    // and the Context Menu row are one behaviour.
    const clickHandler = EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.metaKey || event.ctrlKey || event.button !== 0) return false
            const el = (event.target as HTMLElement | null)?.closest('.cm-asset-link') as HTMLElement | null
            const href = el?.getAttribute('data-href')
            if (!href || !options.store()) return false
            const target = assetLinkTarget(view, el!, href, 'start')
            if (!target) return false
            event.preventDefault()
            view.focus()
            const commands = tryGetActiveCommandRegistry()
            const command = assetClickCommand(href)
            if (commands?.has(command)) void commands.execute(command, target)
            return true
        },
        contextmenu(event, view) {
            const el = (event.target as HTMLElement | null)?.closest('.cm-asset-link') as HTMLElement | null
            const href = el?.getAttribute('data-href')
            if (!href) return false
            const target = assetLinkTarget(view, el!, href, 'start')
            if (!target) return false
            event.preventDefault()
            // Raised here rather than through attachAssetContextMenu: a mark decoration has no
            // element this augmentation owns across rebuilds.
            view.focus()
            openContextMenu(target, event.clientX, event.clientY)
            return true
        },
    })

    const theme = [
        actionClusterTheme('cm-asset-actions', 'cm-asset-action'),
        EditorView.baseTheme({
            // A vertical middle sits a pixel below the middle of the link's text.
            '.cm-asset-actions, .cm-asset-extension': { position: 'relative', top: '-1px' },
            '.cm-asset-link': { color: 'var(--gk-accent, #007ACC)', textDecoration: 'underline' },
            // The task badges' pill, as tall as the action buttons beside it and centred with them, at
            // the size of the text it sits in but never under the floor.
            '.cm-asset-extension': {
                display: 'inline-flex',
                alignItems: 'center',
                boxSizing: 'border-box',
                height: '22px',
                marginLeft: '4px',
                padding: '0 6px',
                border: 'none',
                borderRadius: '4px',
                background: 'var(--gk-surface-2, rgba(127,127,127,0.15))',
                color: 'var(--gk-text-default, currentColor)',
                fontFamily: 'inherit',
                fontSize: 'max(0.875rem, 0.85em)',
                fontWeight: '600',
                lineHeight: '1',
                verticalAlign: 'middle',
                userSelect: 'none',
            },
            'button.cm-asset-extension': { cursor: 'pointer' },
            '.cm-asset-action[data-asset-action="asset.delete"]:hover': {
                color: 'var(--gk-danger, #d23f31)',
            },
        }),
    ]

    return [plugin, clickHandler, theme]
}
