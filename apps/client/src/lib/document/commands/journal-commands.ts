/**
 * The [[Journal Roll]]'s Command (ADR 0136): **Show older entry** loads the next older written day
 * beneath whatever the roll has loaded, and focuses that day's bar. It is the keyboard's way into
 * the roll when nothing links to the entry, so there is no backlinks section to reach the bar
 * through (Tab in the text indents). Offered from the tab's entry or a day loaded beneath it, while
 * there is an older day to load under the cap.
 */

import { type CommandRegistry, type ContributionRegistry, registerCommandMenuItem } from '$lib/surface'

import { getActiveEditorView } from '../active-editor'
import { journalRollOf, type JournalRollControl } from '../view/journal-roll-dom'

export const JOURNAL_SHOW_OLDER_ENTRY = 'journal.showOlderEntry'

export interface JournalCommandDeps {
    /** The roll the active editor belongs to; the real lookup unless a test stands in. */
    rollOf?: () => JournalRollControl | null
}

function activeRoll(): JournalRollControl | null {
    const view = getActiveEditorView()
    return view ? journalRollOf(view) : null
}

export function registerJournalCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: JournalCommandDeps = {},
): () => void {
    const rollOf = deps.rollOf ?? activeRoll
    const offs = [
        commands.register(JOURNAL_SHOW_OLDER_ENTRY, async () => {
            await rollOf()?.loadAndFocus()
        }),
        // Not gated on `bodyWritable`: it writes nothing.
        registerCommandMenuItem(contributions, {
            id: JOURNAL_SHOW_OLDER_ENTRY,
            title: 'Show older entry',
            detail: 'Load the previous journal entry below this one',
            icon: 'move-down',
            group: 'Navigate',
            order: 14,
            keywords: ['journal', 'previous', 'day', 'yesterday', 'roll'],
            when: () => rollOf()?.canLoad() ?? false,
            command: JOURNAL_SHOW_OLDER_ENTRY,
        }),
    ]
    return () => {
        for (const off of offs) off()
    }
}
