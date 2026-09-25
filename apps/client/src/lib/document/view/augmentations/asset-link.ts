/**
 * Augmentation: mark every [[Asset Reference]] that is not a rendered image
 * (`[report](../assets/q3.pdf)`) with `.cm-asset-link`, and follow it with the shared action
 * cluster — download, open in a tab where a viewer is registered, delete. A plain click on the
 * link itself still downloads; holding the mod key (Ctrl / ⌘) places the caret instead, which is
 * how the link text is edited (the same rule as the wikilink augmentation).
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

import { type EditorState, type Extension, type Range, RangeSet, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'

import { type AssetStore, assetNameFromRef } from '$lib/storage/fs/asset-store'
import { openContextMenu, tryGetActiveCommandRegistry } from '$lib/surface'

import { assetTargetAt, attachAssetContextMenu, buildAssetActions } from './asset-actions'
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
        const resolve = () => assetTargetAt(view, wrap, this.ref, 'end')
        const wrap = buildAssetActions(view, this.ref, resolve, { className: 'cm-asset-actions', size: 16 })
        attachAssetContextMenu(view, wrap, resolve)
        return wrap
    }

    ignoreEvent(): boolean {
        return true // the cluster's own listeners handle everything; keep CodeMirror out of it
    }
}

/** One asset link this augmentation renders: the whole `[label](target)` and its target. */
export interface AssetLinkSpan {
    from: number
    to: number
    target: string
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
    const { codeRanges } = analysisFor(state)
    for (const link of markdownLinks(state.doc.toString())) {
        const { from, to, target } = link
        if (isInCode(codeRanges, from, to)) continue // code is opaque
        if (assetNameFromRef(target) === null) continue // not an asset reference
        // An image the embed renders is the embed's; an image the embed leaves alone (written
        // inside prose, where the line holds more than the image) is ours.
        if (link.bang === '!' && isImageTarget(target) && isImageLine(state.doc.lineAt(from).text)) continue
        spans.push({ from, to, target })
    }
    spansByDoc.set(state.doc, spans)
    return spans
}

function buildDecorations(view: EditorView): DecorationSet {
    const decos: Range<Decoration>[] = []
    for (const { from, to, target } of assetLinkSpans(view.state)) {
        decos.push(
            Decoration.mark({
                class: 'cm-asset-link',
                attributes: { 'data-augmentation': 'asset-link', 'data-href': target },
            }).range(from, to),
        )
        decos.push(Decoration.widget({ widget: new AssetActionsWidget(target), side: 1 }).range(to))
    }
    // Two decorations share the `to` offset of every link, so build the set from a sorted range
    // list rather than a RangeSetBuilder, which requires strictly increasing starts.
    return RangeSet.of(decos, true)
}

export function assetLinkAugmentation(options: AssetLinkOptions): Extension {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet
            constructor(view: EditorView) {
                this.decorations = buildDecorations(view)
            }
            update(update: ViewUpdate) {
                if (update.docChanged) this.decorations = buildDecorations(update.view)
            }
        },
        { decorations: (v) => v.decorations },
    )

    // Plain click downloads; the mod key suppresses it, leaving the click to place the caret
    // and start a selection inside the link text (the wikilink / markdown-link rule). Taken on
    // `mousedown`, before the caret moves. Routed through the Command so the click, the icon
    // and the Context Menu row are one behaviour.
    const clickHandler = EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.metaKey || event.ctrlKey || event.button !== 0) return false
            const el = (event.target as HTMLElement | null)?.closest('.cm-asset-link') as HTMLElement | null
            const href = el?.getAttribute('data-href')
            if (!href || !options.store()) return false
            const target = assetTargetAt(view, el!, href, 'start')
            if (!target) return false
            event.preventDefault()
            view.focus()
            const commands = tryGetActiveCommandRegistry()
            if (commands?.has('asset.download')) void commands.execute('asset.download', target)
            return true
        },
        contextmenu(event, view) {
            const el = (event.target as HTMLElement | null)?.closest('.cm-asset-link') as HTMLElement | null
            const href = el?.getAttribute('data-href')
            if (!href) return false
            const target = assetTargetAt(view, el!, href, 'start')
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
            '.cm-asset-link': { color: 'var(--gk-accent, #007ACC)', textDecoration: 'underline' },
            '.cm-asset-action[data-asset-action="asset.delete"]:hover': {
                color: 'var(--gk-danger, #d23f31)',
            },
        }),
    ]

    return [plugin, clickHandler, theme]
}
