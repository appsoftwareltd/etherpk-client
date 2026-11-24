/**
 * Spell Check in a [[Plain Folder]]: the tab's one spell service, opened on the folder while the
 * device preference is on, with the words the person added kept in the folder's hidden `.etherpk`
 * folder, one file for each word (plain-state-folder.ts, ADR 0197).
 *
 * The same service, preference, Commands and menu rows a graph has. Only where the added words are
 * kept differs.
 */
import { sha1 } from '../document/ebook/sha1'
import { isSpellCheckEnabled, subscribeSpellCheck } from '../document/spell-check-preference'
import { setActiveSpellService } from '../document/spelling/active-spell-service'
import { getBrowserSpellService } from '../document/spelling/spell-service-host'
import { sanitizeDictionaryWords, setGraphDictionary, subscribeGraphDictionary } from '../document/spelling/graph-dictionary'
import { bindSpellingNotices } from '../document/spelling/spelling-notices'

import type { PlainStateFolder } from './plain-state-folder'

export const DICTIONARY = 'dictionary'

/** A word's file name: a hash of the word, since a word can hold characters a file name cannot. */
export function wordId(word: string): string {
    return [...sha1(word)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The words kept in the folder, read from its items. */
export async function readDictionary(folder: PlainStateFolder): Promise<string[]> {
    const words = (await folder.list(DICTIONARY)).map((item) => (typeof item.value === 'object' && item.value !== null ? (item.value as { word?: unknown }).word : undefined))
    return sanitizeDictionaryWords(words)
}

/** The dictionary's `persist`: a word added is a file written, a word removed a file removed. */
export function dictionaryPersist(folder: PlainStateFolder) {
    return {
        add: (word: string) => folder.put(DICTIONARY, wordId(word), { word }),
        async remove(words: readonly string[]) {
            for (const word of words) await folder.remove(DICTIONARY, wordId(word))
        },
    }
}

/**
 * Open Spell Check on a Plain Folder with the `words` read from it ({@link readDictionary}). Returns
 * what closes it. It reads nothing itself, so a folder left while it was being read opens none of it.
 */
export function openPlainSpelling(folder: PlainStateFolder, folderId: string, words: string[]): () => void {
    setGraphDictionary(words, dictionaryPersist(folder))
    const spell = getBrowserSpellService()
    setActiveSpellService(spell)
    const followPreference = (enabled: boolean) => (enabled ? spell.open(folderId) : spell.close())
    followPreference(isSpellCheckEnabled())
    const stops = [subscribeSpellCheck(followPreference), subscribeGraphDictionary((words) => spell.setWords(words)), bindSpellingNotices(spell)]
    const retry = () => spell.retry()
    window.addEventListener('online', retry)
    return () => {
        window.removeEventListener('online', retry)
        for (const stop of stops) stop()
        spell.close()
        setActiveSpellService(null)
        setGraphDictionary([], null)
    }
}
