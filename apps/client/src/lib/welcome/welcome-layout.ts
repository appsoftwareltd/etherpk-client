/**
 * The Layout a graph created empty opens with, once its Welcome page is written (ADR 0183).
 *
 * The page is the document in front. Today's journal is open as well, as a tab to its right in
 * the same Pane, and stays a Draft until it is typed in. A phone shows one View at a time under
 * its drawers, so there the left drawer starts closed and the page is what a person sees.
 */
import type { SerializedLayout } from '#lib/layout/types.js'
import { viewKey } from '#lib/layout/view-ref.js'

import { WELCOME_PAGE_TITLE } from './welcome-page'

/**
 * `fresh` (a new graph's default Layout, today's journal alone in the editor area) with the
 * Welcome page added in front of the journal. Never mutates `fresh`.
 */
export function welcomeFirstLayout(fresh: SerializedLayout, options: { phone: boolean }): SerializedLayout {
    const layout = structuredClone(fresh)
    const view = { kind: 'document', target: WELCOME_PAGE_TITLE } as const
    const panelId = viewKey(view)
    const { regions } = layout.model
    const [pane] = regions.main.panes
    if (!pane) return layout
    pane.views.unshift({ panelId, view })
    pane.activePanelId = panelId
    layout.model.activePanelId = panelId
    if (options.phone) regions['left-sidebar'].collapsed = true
    return layout
}
