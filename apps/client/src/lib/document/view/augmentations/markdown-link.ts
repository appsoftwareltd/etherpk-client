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
import { type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

import { fileLinkActions, LINK_COPY_PATH, runLinkCommand } from '../../link-affordances'
import { hiddenSyntax, hiddenSyntaxPlugin } from './base-renderer'
import { actionClusterTheme, buildActionCluster, confirmClusterAction } from './inline-actions'
import { linkPieces } from './markdown-link-core'

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

/** Line-kind reveal (reveal-policy.ts): a link's syntax shows raw while the caret is on its line. */
const linkSyntax = hiddenSyntaxPlugin({
    pieces(view, from, to, reveal) {
        const { state } = view
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

    return [linkSyntax, clickHandler, theme, actionClusterTheme('cm-file-link-actions', 'cm-file-link-action')]
}
