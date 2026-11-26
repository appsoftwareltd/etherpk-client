/**
 * The rows a [[Block View]]'s tab menu adds (ADR 0209), and the Command Menu's **Open Block in tab**.
 * A Block View is one Block of a document, so the rows about a whole document (rename, publish,
 * protect, version history, delete, frontmatter, backlinks, favourites) are not offered on its tab;
 * these take their place. Print is `print-commands.ts`'s, and pinning and closing are the tab rows
 * every View has (`layout/tab-commands.ts`).
 */
import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '../../surface'
import type { PaneSide } from '#lib/layout/index.js'

import { getActiveEditorView } from '../active-editor'
import type { BlockLink } from '../block-link'
import { BLOCK_VIEW_KIND, currentBlockLink, liveBlockView } from '../block-view'
import { blockRange } from '../view/block-actions'
import { blockLinkInEditor } from '../view/block-view-range'
import { editorDocument } from '../view/editor-document'

export const BLOCK_VIEW_OPEN_DOCUMENT = 'blockView.openDocument'
export const BLOCK_VIEW_OPEN_DOCUMENT_RIGHT = 'blockView.openDocumentRight'
export const BLOCK_VIEW_OPEN_DOCUMENT_BELOW = 'blockView.openDocumentBelow'
export const BLOCK_VIEW_FIND = 'blockView.find'
export const BLOCK_VIEW_COPY_LINK = 'blockView.copyLink'
export const BLOCK_OPEN_AT_CARET = 'block.openAtCaret'

export interface BlockViewCommandDeps {
    /** Open `document` at its 0-based body `line`, in the Pane holding `panelId`, or beside it. */
    openDocument(document: string, line: number, panelId: string, side?: PaneSide): void
    /** Whether a Pane can be opened beside the one holding `panelId`. */
    canOpenBeside(panelId: string): boolean
    /** Bring the Block View in `panelId` to the front of its Pane. */
    front(panelId: string): void
    /** Put a Block's address on the clipboard, and say so. */
    copyLink(link: BlockLink): Promise<void>
    /** Open a Block View of a link's Block, in the Pane holding `panelId`. */
    openBlock(link: BlockLink, panelId: string | undefined): void
}

/** The Block View a tab's menu was raised on: its panel and target. */
function blockTab(target: ContextMenuTarget): { panelId: string; target: string } | null {
    if (target.kind !== 'tab' || target.view?.kind !== BLOCK_VIEW_KIND) return null
    return { panelId: target.panelId, target: target.view.target }
}

/** The bullet the cursor is on in the editor last used, its 1-based line, and its document. */
function caretBullet(): { line: number; concept: string; panelId: string | undefined; view: NonNullable<ReturnType<typeof getActiveEditorView>> } | null {
    const view = getActiveEditorView()
    const document = view?.state.facet(editorDocument)
    if (!view || !document) return null
    const line = view.state.doc.lineAt(view.state.selection.main.head).number
    return blockRange(view.state, line) === null ? null : { line, concept: document.concept, panelId: document.panelId, view }
}

/** Where a Block View's Block is: live, or where it was last seen, or its target. */
function whereOf(target: string): { document: string; line: number } | null {
    return liveBlockView(target)?.where() ?? currentBlockLink(target)
}

export function registerBlockViewCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: BlockViewCommandDeps): () => void {
    /** A handler for a row on a Block View's tab, given the tab and where its Block is. */
    const onTab = (run: (tab: { panelId: string; target: string }, where: { document: string; line: number }) => void) => (arg?: unknown) => {
        const tab = arg && typeof arg === 'object' ? blockTab(arg as ContextMenuTarget) : null
        const where = tab ? whereOf(tab.target) : null
        if (tab && where) run(tab, where)
    }
    const documentOf = (target: ContextMenuTarget) => {
        const tab = blockTab(target)
        return tab ? (whereOf(tab.target)?.document ?? null) : null
    }
    const disposers = [
        commands.register(BLOCK_VIEW_OPEN_DOCUMENT, onTab((tab, where) => deps.openDocument(where.document, where.line, tab.panelId))),
        commands.register(BLOCK_VIEW_OPEN_DOCUMENT_RIGHT, onTab((tab, where) => deps.openDocument(where.document, where.line, tab.panelId, 'right'))),
        commands.register(BLOCK_VIEW_OPEN_DOCUMENT_BELOW, onTab((tab, where) => deps.openDocument(where.document, where.line, tab.panelId, 'below'))),
        commands.register(
            BLOCK_VIEW_FIND,
            onTab((tab) => {
                deps.front(tab.panelId)
                // A frame, so the menu has closed and handed the focus back before the box takes it.
                requestAnimationFrame(() => liveBlockView(tab.target)?.find())
            }),
        ),
        commands.register(BLOCK_VIEW_COPY_LINK, (arg?: unknown) => {
            const tab = arg && typeof arg === 'object' ? blockTab(arg as ContextMenuTarget) : null
            const link = tab ? currentBlockLink(tab.target) : null
            if (link) void deps.copyLink(link)
        }),
        commands.register(BLOCK_OPEN_AT_CARET, async () => {
            const caret = caretBullet()
            const link = caret ? await blockLinkInEditor(caret.view.state, caret.line, caret.concept) : null
            if (caret && link) deps.openBlock(link, caret.panelId)
        }),
        // First, as Find in document is on a document's tab: it acts on the tab's own text.
        registerContextMenuItem(contributions, {
            id: BLOCK_VIEW_FIND,
            label: 'Find in block',
            command: BLOCK_VIEW_FIND,
            icon: 'search',
            order: 4,
            when: (target) => liveBlockView(blockTab(target)?.target ?? '') !== undefined,
        }),
        registerContextMenuItem(contributions, {
            id: BLOCK_VIEW_OPEN_DOCUMENT,
            label: (target) => `Open ${documentOf(target) ?? 'the page'}`,
            command: BLOCK_VIEW_OPEN_DOCUMENT,
            icon: 'page',
            order: 5,
            when: (target) => documentOf(target) !== null,
        }),
        registerContextMenuItem(contributions, {
            id: BLOCK_VIEW_OPEN_DOCUMENT_RIGHT,
            label: (target) => `Open ${documentOf(target) ?? 'the page'} in pane to the right`,
            command: BLOCK_VIEW_OPEN_DOCUMENT_RIGHT,
            icon: 'pane-right',
            order: 6,
            when: (target) => documentOf(target) !== null && deps.canOpenBeside(blockTab(target)!.panelId),
        }),
        registerContextMenuItem(contributions, {
            id: BLOCK_VIEW_OPEN_DOCUMENT_BELOW,
            label: (target) => `Open ${documentOf(target) ?? 'the page'} in pane below`,
            command: BLOCK_VIEW_OPEN_DOCUMENT_BELOW,
            icon: 'pane-below',
            order: 7,
            when: (target) => documentOf(target) !== null && deps.canOpenBeside(blockTab(target)!.panelId),
        }),
        registerContextMenuItem(contributions, {
            id: BLOCK_VIEW_COPY_LINK,
            label: 'Copy link to block',
            command: BLOCK_VIEW_COPY_LINK,
            icon: 'copy',
            order: 8,
            when: (target) => blockTab(target) !== null && currentBlockLink(blockTab(target)!.target) !== null,
        }),
        registerCommandMenuItem(contributions, {
            id: BLOCK_OPEN_AT_CARET,
            title: 'Open Block in tab',
            detail: 'Show the block the cursor is in, with the blocks nested under that block, in a tab of its own',
            icon: 'view-larger',
            group: 'Go to',
            order: 12,
            keywords: ['zoom', 'focus', 'block', 'bullet', 'tab', 'outline'],
            command: BLOCK_OPEN_AT_CARET,
            when: () => caretBullet() !== null,
        }),
    ]
    return () => {
        for (const dispose of disposers) dispose()
    }
}
