/**
 * The [[Spell Check]] Commands and where they are offered (ADR 0095):
 *
 * - the spelling menu's rows, on a `misspelling` Context Menu target: up to five corrections,
 *   **Add "word" to the graph dictionary**, and **Spelling languages…**;
 * - **Fix spelling**, a Contextual Group on the phone's Command Bar while the caret is in a
 *   misspelt word, which opens the same menu (a long-press is left to native text selection);
 * - the `/` row **Spelling languages**, which opens the Settings dialog's Spelling tab.
 *
 * `spelling.openSettings` itself is the workspace's (it owns the Settings dialog); these rows
 * only name it.
 */

import { showNotice } from '$lib/activity/notices'

import {
    type CommandRegistry,
    type ContributionRegistry,
    isMisspellingTarget,
    type MisspellingContextMenuTarget,
    registerCommandBarItem,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '../../surface'
import { getActiveEditorView } from '../active-editor'
import { addDictionaryWord } from '../spelling/graph-dictionary'
import { openSpellingMenuAtCaret } from '../view/augmentations/spell-check'
import { focusMenuEditor, replaceMisspelling } from '../view/spelling-menu'

/** How many corrections the menu shows. */
export const MAX_SUGGESTIONS = 5

export const SPELLING_OPEN_SETTINGS = 'spelling.openSettings'

/** The Command for the `index`th suggestion row. */
export const suggestionCommand = (index: number) => `spelling.useSuggestion.${index}`

function misspelling(arg: unknown): MisspellingContextMenuTarget | null {
    const target = arg as MisspellingContextMenuTarget | undefined
    return target && isMisspellingTarget(target) ? target : null
}

export function registerSpellingCommands(commands: CommandRegistry, contributions: ContributionRegistry): () => void {
    const offs: (() => void)[] = []

    for (let index = 0; index < MAX_SUGGESTIONS; index++) {
        offs.push(
            commands.register(suggestionCommand(index), (arg?: unknown) => {
                const target = misspelling(arg)
                const replacement = target?.suggestions[index]
                if (!target || replacement === undefined) return
                if (!replaceMisspelling(target, replacement)) {
                    showNotice({
                        id: 'spelling',
                        tone: 'info',
                        text: `"${target.word}" changed while the menu was open, so it was left as it is.`,
                    })
                }
            }),
        )
        offs.push(
            registerContextMenuItem(contributions, {
                id: suggestionCommand(index),
                label: (target) => (isMisspellingTarget(target) ? (target.suggestions[index] ?? '') : ''),
                order: index,
                command: suggestionCommand(index),
                when: (target) => isMisspellingTarget(target) && target.suggestions.length > index,
            }),
        )
    }

    offs.push(
        commands.register('spelling.addToDictionary', async (arg?: unknown) => {
            const target = misspelling(arg)
            if (!target) return
            focusMenuEditor()
            try {
                const added = await addDictionaryWord(target.word)
                if (!added) {
                    showNotice({
                        id: 'spelling',
                        tone: 'error',
                        text: `"${target.word}" could not be added: the graph dictionary is full.`,
                    })
                }
            } catch (err) {
                showNotice({
                    id: 'spelling',
                    tone: 'error',
                    text: `"${target.word}" could not be added to the graph dictionary: ${(err as Error).message}`,
                })
            }
        }),
    )
    offs.push(
        registerContextMenuItem(contributions, {
            id: 'spelling.addToDictionary',
            label: (target) => `Add "${isMisspellingTarget(target) ? target.word : ''}" to the graph dictionary`,
            order: 10,
            separatorBefore: true,
            command: 'spelling.addToDictionary',
            when: isMisspellingTarget,
        }),
    )
    offs.push(
        registerContextMenuItem(contributions, {
            id: 'spelling.languages',
            label: 'Spelling languages…',
            order: 11,
            command: SPELLING_OPEN_SETTINGS,
            when: isMisspellingTarget,
        }),
    )

    // Fix spelling: the phone's way to the menu, where right-click and Shift+F10 are not.
    offs.push(
        commands.register('spelling.openMenuAtCaret', () => {
            const view = getActiveEditorView()
            if (view) openSpellingMenuAtCaret(view)
        }),
    )
    offs.push(
        registerCommandBarItem(contributions, {
            id: 'spelling.fix',
            icon: 'spell-check',
            label: 'Fix spelling',
            order: 0,
            command: 'spelling.openMenuAtCaret',
            contextualGroup: 'spelling',
        }),
    )

    offs.push(
        registerCommandMenuItem(contributions, {
            id: SPELLING_OPEN_SETTINGS,
            title: 'Spelling languages',
            detail: 'Choose the languages this graph is checked in',
            icon: 'spell-check',
            group: 'Editor',
            keywords: ['spelling', 'spellcheck', 'dictionary', 'language'],
            command: SPELLING_OPEN_SETTINGS,
        }),
    )

    return () => offs.forEach((off) => off())
}
