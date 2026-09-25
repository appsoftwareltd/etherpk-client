/**
 * The View registry — the `kind → Svelte component` map the renderer consults
 * to know what to mount, plus the natural region and tab title for each kind.
 *
 * It is now a **typed facade over the generic Contribution registry** (the `'view'`
 * point) — the original, specialised Contribution Point, hosted on the same registry
 * that carries the Command Menu's menu-item kind (see
 * docs/adr/0017-contribution-registry-generalised-early-for-the-command-menu.md). Pass a
 * shared `ContributionRegistry` so the View and menu-item kinds genuinely live in one
 * registry; called with no argument it owns a private one (the unit tests' path).
 *
 * The real app registers `document → DocumentView`, `backlinks → BacklinksView`,
 * etc. The dev harness registers every kind to a single fake `DevView`, which is
 * what lets the whole Layout be exercised with no real documents or data.
 *
 * First-party kinds are unprefixed (`document`, `backlinks`, …); extension kinds
 * are namespaced as `"<extensionId>.<kind>"` (see {@link namespacedViewKind}) so
 * two extensions cannot collide. Registering a kind that is already present, or
 * one that is not registerable, throws rather than silently clobbering.
 */

import { type ContributionRegistry, createContributionRegistry } from '../surface'

import type { ViewRef, ViewRegistry, ViewRegistryEntry } from './types'
import { KEY_SEPARATOR, isRegisterableViewKind } from './view-ref'

/** The Contribution registry point kind the View registry stores under. */
const VIEW_KIND = 'view'

/**
 * About how many characters of a title a tab shows before it is ellipsised. Enough for most
 * document names to read whole; a long one no longer pushes every other tab off the strip.
 */
export const TAB_TITLE_CHARS = 30

export function createViewRegistry(
    contributions: ContributionRegistry = createContributionRegistry(),
): ViewRegistry {
    const entry = (kind: string) => contributions.get(VIEW_KIND, kind) as ViewRegistryEntry | undefined

    return {
        register(view) {
            if (!isRegisterableViewKind(view.kind)) {
                throw new Error(
                    `Invalid view kind ${JSON.stringify(view.kind)}: a kind must be non-empty ` +
                        `and must not contain ${JSON.stringify(KEY_SEPARATOR)}.`,
                )
            }
            if (contributions.has(VIEW_KIND, view.kind)) {
                throw new Error(
                    `View kind ${JSON.stringify(view.kind)} is already registered. ` +
                        `Two extensions may be claiming the same kind — namespace it as ` +
                        `"<extensionId>.${view.kind}".`,
                )
            }
            contributions.register(VIEW_KIND, view.kind, view)
        },
        unregister(kind) {
            contributions.unregister(VIEW_KIND, kind)
        },
        get(kind) {
            return entry(kind)
        },
        has(kind) {
            return contributions.has(VIEW_KIND, kind)
        },
        naturalRegion(kind) {
            return entry(kind)?.naturalRegion
        },
        title(view: ViewRef) {
            const e = entry(view.kind)
            return e?.title ? e.title(view) : view.target
        },
        icon(view: ViewRef) {
            return entry(view.kind)?.icon
        },
        tabTitleChars(view: ViewRef) {
            // Code points, as a reader counts them, not UTF-16 units.
            return TAB_TITLE_CHARS + [...(entry(view.kind)?.titlePrefix ?? '')].length
        },
    }
}
