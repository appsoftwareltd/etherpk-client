/**
 * The backlinks a person is shown, out of everything the index knows links to a concept.
 *
 * `backlinksFor` answers for a rename as well as for a view, so it keeps two kinds of source a
 * view leaves out, each marked:
 *
 * - a document linking to its own name (ADR 0135), and
 * - a [[Template]]'s body links (ADR 0144). A Template is a pattern, so a `[[Garden]]` in it is
 *   not a reference to Garden, but a rename of Garden must still rewrite it. The Template's own
 *   name is kept: `[[Templates]] Daily` is scoped by Templates whatever the page holds.
 *
 * Every surface that shows backlinks reads them through here, so they agree.
 */

import type { DbBacklinkGroup } from '../index-db'

/** What the Backlinks panel, the section beneath a document and the Journal Roll show. */
export function shownBacklinkGroups(groups: readonly DbBacklinkGroup[]): DbBacklinkGroup[] {
    return withoutTemplateContent(groups.filter((group) => !group.sourceIsTarget))
}

/**
 * The groups with a Template's body links left out and its title kept. A Template whose only
 * links are in its body drops out whole.
 */
export function withoutTemplateContent(groups: readonly DbBacklinkGroup[]): DbBacklinkGroup[] {
    const kept: DbBacklinkGroup[] = []
    for (const group of groups) {
        if (!group.sourceIsTemplate) {
            kept.push(group)
            continue
        }
        const refs = group.refs.filter((ref) => ref.kind === 'title')
        if (refs.length > 0) kept.push({ ...group, refs, bodyNames: [] })
    }
    return kept
}
