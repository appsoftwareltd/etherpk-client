/**
 * Open a concept — the shared navigate behaviour used by both the editor's wikilink click
 * and the Backlinks View's clickable references. Reads the active index / layout through
 * their module accessors (callers are mounted via the dockview adapter's mount(), so cannot
 * use Svelte context). A no-op outside a graph workspace (e.g. the /dev/editor harness),
 * where there is no layout controller.
 *
 * Opening writes NOTHING. A concept with no page opens as a [[Draft]] (ADR 0050), which
 * creates its page only once something is typed into it — so a stray click on a missing link
 * costs nothing, and there is no confirmation to answer. This replaced a create-prompt dialog
 * that asked the wrong question: someone clicking `[[Kanban]]` wants to SEE Kanban, and being
 * asked whether to create it was a consequence of an implementation detail (that seeing
 * required a document) rather than of anything they intended.
 */

import { getActiveLayoutController, type LayoutController } from '$lib/layout'

import { getActiveGraphIndex } from './backlinks'
import { conceptKey } from './backlinks/backlink-index'
import { revealLine } from './reveal'

/** True when the index knows of no document for this concept (→ missing styling). */
export function conceptIsMissing(concept: string): boolean {
    const index = getActiveGraphIndex()
    return index ? !index.conceptExists(concept) : false
}

/**
 * The name a concept should be opened — and titled — under.
 *
 * A [[Pageless Concept]] opens under the MAJORITY casing among its wikilink instances, which
 * the index already derives (ADR 0050). A Draft reached through `[[kanban]]` while eleven
 * other documents say `[[Kanban]]` opens — and promotes — as `Kanban`, so the page's title
 * does not end up disagreeing with its own backlinks.
 *
 * An alias opens the document it names, not a document called by the alias (same rule
 * [[Quick Find]] and [[Search]] apply in `rankQuickFind`) — otherwise a wikilink or Backlinks
 * click written as the alias would open the right content under the wrong tab title, since
 * the `document` view kind has no title of its own beyond its target.
 */
export function canonicalConceptName(concept: string): string {
    const key = conceptKey(concept)
    const candidate = getActiveGraphIndex()
        ?.allConcepts()
        .find((c) => c.key === key)
    if (candidate?.kind === 'pageless') return candidate.display
    if (candidate?.kind === 'alias') return candidate.canonical ?? concept
    return concept
}

/** The Pane holding `panelId`, from the controller's serialized model, or undefined if not open. */
function paneIdFor(controller: LayoutController, panelId: string): string | undefined {
    const regions = controller.serialize().model.regions
    for (const region of Object.values(regions)) {
        const pane = region.panes.find((p) => p.views.some((v) => v.panelId === panelId))
        if (pane) return pane.id
    }
    return undefined
}

/**
 * Open a concept. `sourcePanelId` — the panel the click happened in — keeps the target in the
 * SAME pane as the document containing the link, rather than wherever the region's active pane
 * happens to be: a link clicked in a non-focused split pane should navigate that pane, not
 * whichever one the user last worked in.
 */
export function openConcept(concept: string, sourcePanelId?: string): void {
    tryOpen(canonicalConceptName(concept), sourcePanelId)
}

/**
 * Open a concept AT A LINE: a [[Tasks View]] row or a [[Backlink]] landing on the block it was
 * indexed from, rather than at the top of the document or its remembered [[Reading Position]].
 * `line` is 0-based and body-relative, as the [[Derived Index]] records it; the editor adds any
 * frontmatter above the body when it lands (`reveal.ts`).
 *
 * The reveal is addressed to the name the View opens AS. An alias opens the canonical page, so
 * a reveal addressed to the alias would wait for a View that never mounts. And it is asked for
 * only once the View has actually been opened: where nothing can open (the /dev harnesses) a
 * pending reveal would otherwise lie in wait for the next unrelated opening of that concept.
 */
export function openConceptAtLine(concept: string, line: number, sourcePanelId?: string): void {
    const target = canonicalConceptName(concept)
    if (!tryOpen(target, sourcePanelId)) return
    revealLine(target, line)
}

/** Open `target` (already canonical) in the source panel's pane; false when there is no layout. */
function tryOpen(target: string, sourcePanelId?: string): boolean {
    try {
        const controller = getActiveLayoutController()
        const paneId = sourcePanelId ? paneIdFor(controller, sourcePanelId) : undefined
        controller.openView({ kind: 'document', target }, paneId ? { paneId } : {})
        return true
    } catch {
        /* no active layout controller (dev harness): nothing to navigate */
        return false
    }
}
