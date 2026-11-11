/**
 * **Share this graph**: the [[Owner]] of a synced graph invites a [[Player]] from inside it, as
 * well as from the graph's card on the Graphs page. A Command, a row of every tab's menu and a
 * row of the Command Menu, all opening the same invite dialog.
 *
 * The rows are left out, not greyed, for anybody who cannot share: a graph in a folder has
 * nobody to invite, and a Player cannot invite.
 */

import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '#lib/surface/index.js'

export const GRAPH_SHARE = 'graph.share'

export interface ShareCommandDeps {
    /** Open the invite dialog for the open graph. */
    share: () => void
    /**
     * Whether this person may share the open graph. Asked each time a menu opens, because the
     * Sync Server answers after the graph is on screen.
     */
    shareable: () => boolean
}

const isTab = (target: ContextMenuTarget) => target.kind === 'tab' || target.kind === 'document-tab'

export function registerShareCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: ShareCommandDeps,
): () => void {
    const offs = [
        commands.register(GRAPH_SHARE, () => {
            if (deps.shareable()) deps.share()
        }),
        registerContextMenuItem(contributions, {
            id: GRAPH_SHARE,
            label: 'Share this graph…',
            command: GRAPH_SHARE,
            // Last, in a group of its own: it is about the graph, where the rows above it are
            // about the document and then the tab.
            order: 200,
            separatorBefore: true,
            when: (target) => isTab(target) && deps.shareable(),
        }),
        // It writes to no document, so it stays on a locked Protected Document.
        registerCommandMenuItem(contributions, {
            id: GRAPH_SHARE,
            title: 'Share this graph',
            detail: 'Invite someone to edit it with you',
            // No icon of its own: the Client's icon names are part of the Extension API, so one
            // is not added for a single row. The menu draws its default glyph.
            group: 'Settings',
            order: 190,
            keywords: ['share', 'invite', 'player', 'collaborate', 'together', 'access'],
            when: () => deps.shareable(),
            command: GRAPH_SHARE,
        }),
    ]
    return () => {
        for (const off of offs) off()
    }
}
