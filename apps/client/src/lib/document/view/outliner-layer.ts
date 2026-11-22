/**
 * The outliner's keys as an editor loads them: the outliner's own, and ahead of them, in the plain
 * profile, the keys for the list kinds a graph does not write (ADR 0195).
 *
 * The order is the rule. Both bind Tab, Shift+Tab and Enter, and the first to take a key wins, so
 * the plain profile's must come first: the outliner reads a `* ` item as prose. `outliner-layer.test.ts`
 * holds the order, and that a graph's editor has neither the keys nor the facet.
 */
import type { Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'

import { listItemBindings, plainLists } from './list-items-keymap'
import { outlinerKeymap } from './outliner-keymap'

export function outlinerLayer(options: { plain: boolean }): Extension {
    return [options.plain ? [plainLists.of(true), keymap.of([...listItemBindings()])] : [], outlinerKeymap()]
}
