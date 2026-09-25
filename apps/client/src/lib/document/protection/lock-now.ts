/**
 * What a [[Lock Now]] does beyond discarding the key: the Views it closes.
 *
 * A Lock Now is the user's deliberate lock — the Sidebar control, a document's padlock, the
 * Command — as opposed to the app locking on its own when a timer runs out, the tab closes or
 * the graph is switched. Only the deliberate one may touch the Layout: it is the user saying
 * they are leaving, and a row of padlocked tabs still names what they had open. A timer firing
 * mid-work has no business taking anyone's tabs away, so the distinction is drawn here, at the
 * callers, and never inside the lock machine — which stays clock-only (ADR 0058) and cannot tell
 * the two apart.
 *
 * Pure over the serialized model, so "which tabs go" is a unit-testable question.
 */
import type { LayoutModel } from '$lib/layout'

/** The three named regions, in a stable order. Mirrors `layout/model.ts`, which is not public. */
const REGIONS = ['left-sidebar', 'main', 'right-sidebar'] as const

/**
 * The panel ids of every open document View whose document is a [[Protected Document]] —
 * exactly the tabs that wear a padlock, so what closes is what the user can see will close.
 *
 * **Every** instance: a pinned tab (pinning survives the bulk-close Commands, but this is a
 * privacy act, not a tidy-up), a deliberate second copy of the same document, and Views in any
 * Pane. Read from `instance.view.target`, not by parsing the panel id: a copy's id is synthetic
 * and would parse to the wrong target.
 *
 * `isProtectedDocument` is the padlock's own predicate — whole-document protection (ADR 0060),
 * whoever's key it is under. Another Member's protected document closes too: the name on its tab
 * is just as telling, and the rule stays one a user can predict.
 */
export function protectedDocumentPanels(model: LayoutModel, isProtectedDocument: (target: string) => boolean): string[] {
    const ids: string[] = []
    for (const region of REGIONS) {
        for (const pane of model.regions[region].panes) {
            for (const instance of pane.views) {
                if (instance.view.kind !== 'document') continue
                if (!isProtectedDocument(instance.view.target)) continue
                ids.push(instance.panelId)
            }
        }
    }
    return ids
}
