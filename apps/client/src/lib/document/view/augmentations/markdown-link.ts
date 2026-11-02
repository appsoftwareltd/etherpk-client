/**
 * Augmentation: render every **external hyperlink** as a link — styled, underlined and
 * clickable — whatever shape it was written in. A **plain click** opens the target in a new
 * tab; holding the mod key (Ctrl / ⌘) places the caret instead, which is how the link is
 * edited (the wikilink / asset-link rule).
 *
 * `[text](url)` renders as just its text, `<https://example.com>` as just the url — both hide
 * their syntax when the caret is off the line (the same per-line reveal as inline formatting)
 * — and a bare `https://example.com` typed into prose becomes clickable where it stands.
 * Which spans those are, and what each one opens, is {@link linkPieces}; this file is the
 * CodeMirror wiring around it.
 *
 * A [[File Link]] (`file:///…`, CONTEXT.md) is the one hyperlink the browser never opens: a
 * page served from the web cannot load a local file. It renders underlined in the text colour,
 * not the accent, so it does not promise what it cannot do, and it is followed by a copy icon
 * (the same cluster an asset reference carries, `inline-actions.ts`). A click on the text or on
 * the icon copies the native path through the one Command in `link-affordances.ts`, and the
 * icon's tick confirms it whichever was clicked.
 */

import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type MouseSelectionStyle, WidgetType } from '@codemirror/view'

import { fileLinkActions, LINK_COPY_PATH, runLinkCommand } from '../../link-affordances'
import { hiddenSyntax, hiddenSyntaxPieces, hiddenSyntaxPlugin, type HiddenSyntaxSpec } from './base-renderer'
import { actionClusterTheme, buildActionCluster, confirmClusterAction } from './inline-actions'
import { caretBesideLink, type LinkPiece, linkPieces } from './markdown-link-core'

/** The clickable mark. One class for all three shapes — link-cursor.ts keys its cursor off it. */
function linkMark(href: string): Decoration {
    return Decoration.mark({
        class: 'cm-md-link',
        attributes: { 'data-augmentation': 'md-link', 'data-href': href },
    })
}

/** A file link's mark: the same link class (cursor, underline) plus its own, which drops the accent. */
function fileLinkMark(path: string): Decoration {
    return Decoration.mark({
        class: 'cm-md-link cm-md-link--file',
        attributes: { 'data-augmentation': 'md-link', 'data-file-path': path },
    })
}

/** The trailing copy icon after a file link. Its target is the path itself, which never goes stale. */
class FileLinkActionsWidget extends WidgetType {
    constructor(readonly path: string) {
        super()
    }

    eq(other: FileLinkActionsWidget): boolean {
        return other.path === this.path
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = buildActionCluster(view, {
            className: 'cm-file-link-actions',
            buttonClass: 'cm-file-link-action',
            actionAttr: 'data-link-action',
            name: this.path,
            actions: fileLinkActions(),
            size: 16,
            resolveTarget: () => ({ kind: 'file-link' as const, path: this.path }),
            run: runLinkCommand,
        })
        wrap.setAttribute('data-file-link-actions', this.path)
        return wrap
    }

    ignoreEvent(): boolean {
        return true // the cluster's own listeners handle everything; keep CodeMirror out of it
    }
}

/**
 * Links as a declaration over the base renderer (base-renderer.ts). Line-kind reveal
 * (reveal-policy.ts): a link's syntax shows raw while the caret is on its line.
 */
export const markdownLinkSpec: HiddenSyntaxSpec = {
    pieces(state, from, to, reveal) {
        const decos: Range<Decoration>[] = []
        for (const piece of linkPieces({
            tree: syntaxTree(state),
            sliceDoc: (a, b) => state.sliceDoc(a, b),
            from,
            to,
            isActiveLine: (pos) => reveal.lineRevealedAt(pos),
        })) {
            switch (piece.kind) {
                case 'link':
                    decos.push(linkMark(piece.href).range(piece.from, piece.to))
                    break
                case 'file-link':
                    decos.push(fileLinkMark(piece.path).range(piece.from, piece.to))
                    // After the whole construct, as the asset cluster follows a whole `[label](…)`: on a
                    // revealed line the icon then trails the `)` or `>` rather than splitting the syntax.
                    decos.push(Decoration.widget({ widget: new FileLinkActionsWidget(piece.path), side: 1 }).range(piece.construct.to))
                    break
                default:
                    decos.push(hiddenSyntax.range(piece.from, piece.to))
            }
        }
        return decos
    },
}

const linkSyntax = hiddenSyntaxPlugin(markdownLinkSpec)

/**
 * Where a click the hit test resolved to `pos`, off any link's text, puts the caret in `state`
 * (the state the click was made over, whose line may still hide its links' syntax): outside the
 * hidden syntax of a link it lands beside ({@link caretBesideLink}). The spans are the ones the
 * editor draws ({@link hiddenSyntaxPieces}), so a link it shows raw (on a line of a code block)
 * hides nothing here either.
 */
export function linkClickCaret(state: EditorState, pos: number): number {
    const line = state.doc.lineAt(pos)
    const drawn = hiddenSyntaxPieces(markdownLinkSpec, state, [{ from: line.from, to: line.to }])
    const pieces = drawn.flatMap((d): Pick<LinkPiece, 'kind' | 'from' | 'to'>[] => {
        if (d.value === hiddenSyntax) return [{ kind: 'hide', from: d.from, to: d.to }]
        return d.from < d.to ? [{ kind: 'link', from: d.from, to: d.to }] : []
    })
    return caretBesideLink(pieces, pos)
}

/** How far (px) the pointer may wander during a click before it counts as a drag. */
const CLICK_SLOP = 4

/**
 * The pointer gesture for a plain click beside a rendered link: CodeMirror's own, except that it
 * starts from {@link linkClickCaret}. The press reveals the line, so the text under the pointer
 * moves; a drag then extends from that start over the revealed markdown, and a small wander
 * before release stays a click rather than a selection to wherever the reflow put the pointer.
 */
function besideLinkSelection(view: EditorView, start: MouseEvent, anchor: number): MouseSelectionStyle {
    let from = anchor
    return {
        update(update) {
            if (update.docChanged) from = update.changes.mapPos(from)
        },
        get(event) {
            const moved = Math.max(Math.abs(event.clientX - start.clientX), Math.abs(event.clientY - start.clientY))
            if (moved < CLICK_SLOP) return EditorSelection.single(from)
            return EditorSelection.single(from, view.posAtCoords({ x: event.clientX, y: event.clientY }, false))
        },
    }
}

/** A primary-button single click with no modifier key: the only press {@link besideLink} takes. */
function isPlainSingleClick(event: MouseEvent): boolean {
    return event.button === 0 && event.detail <= 1 && !(event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)
}

/**
 * Takes a plain single click that lands beside a rendered link (the hit test at its label's edge)
 * and starts it outside the link's hidden syntax. Every other press is left to CodeMirror: a click
 * on the text opens the link (the handler below), a modified click places the caret where it is
 * aimed, and a double or triple click selects a word or line.
 */
const besideLink = EditorView.mouseSelectionStyle.of((view, event) => {
    if (!isPlainSingleClick(event) || (event.target as Element | null)?.closest?.('.cm-md-link')) return null
    const hit = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    const anchor = linkClickCaret(view.state, hit)
    return anchor === hit ? null : besideLinkSelection(view, event, anchor)
})

/**
 * The copy cluster that follows a file link's span. CodeMirror splits a mark into several spans
 * when another decoration straddles it, and on a revealed line the hidden-syntax spans sit between
 * the label and the cluster, so the walk continues past siblings that belong to the same link
 * (the same path) and stops only at a different link.
 */
function clusterAfter(el: Element, path: string): Element | null {
    for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
        if (next.classList.contains('cm-file-link-actions')) return next
        if (next.classList.contains('cm-md-link') && next.getAttribute('data-file-path') !== path) return null
    }
    return null
}

const theme = EditorView.baseTheme({
    '.cm-md-link': { color: 'var(--gk-accent, #007ACC)', textDecoration: 'underline', cursor: 'pointer' },
    // A file link keeps the underline and the pointer but not the accent: it will not open.
    '.cm-md-link.cm-md-link--file': { color: 'inherit' },
})

/** The markdown-link augmentation: render link text + plain-click to open (prose and outliner blocks). */
export function markdownLinkAugmentation(): Extension {
    // Plain click opens; the mod key suppresses it, leaving the click to place the caret and
    // start a selection inside the link text (the wikilink / asset-link rule). Taken on
    // `mousedown`, before the caret lands on the line and rebuilds this decoration.
    const clickHandler = EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.metaKey || event.ctrlKey || event.button !== 0) return false
            const el = (event.target as HTMLElement | null)?.closest('.cm-md-link')
            if (!el) return false
            const path = el.getAttribute('data-file-path')
            if (path) {
                // A file link copies its path, through the same Command its icon runs, and the
                // icon's tick confirms it: the copy is invisible otherwise.
                event.preventDefault()
                view.focus()
                const cluster = clusterAfter(el, path)
                void runLinkCommand(LINK_COPY_PATH, { kind: 'file-link', path }).then((done) => {
                    if (done && cluster) confirmClusterAction(cluster, LINK_COPY_PATH)
                })
                return true
            }
            const href = el.getAttribute('data-href')
            if (!href) return false
            event.preventDefault()
            window.open(href, '_blank', 'noopener,noreferrer')
            return true
        },
    })

    return [linkSyntax, clickHandler, besideLink, theme, actionClusterTheme('cm-file-link-actions', 'cm-file-link-action')]
}
