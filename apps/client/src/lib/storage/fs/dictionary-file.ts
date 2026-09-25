/**
 * The [[Graph Dictionary]] of a [[Filesystem Backend]] graph: `etherpk/dictionary.txt` (ADR 0095).
 * One word per line, sorted, so a change is a one-line diff and two people adding different
 * words merge under git without a conflict; the same file a [[Local Mirror]] writes for a synced
 * graph and an [[Export]] carries. One browser owns the folder, so the whole list is written each
 * time.
 *
 * Read/write go through the {@link DirectoryAdapter} seam, so this is pure and Node-testable over
 * the in-memory adapter. A missing file reads as no words.
 */

import { dictionaryFileText, parseDictionaryFile } from '$lib/document/spelling/graph-dictionary'

import type { DirectoryAdapter } from './directory-adapter'

/** The dictionary file under the graph's `etherpk/` folder. */
export const DICTIONARY_FILE = 'dictionary.txt'

export async function readDictionary(adapter: DirectoryAdapter): Promise<string[]> {
    try {
        const { text } = await adapter.read('etherpk', DICTIONARY_FILE)
        return parseDictionaryFile(text)
    } catch {
        return []
    }
}

export async function writeDictionary(adapter: DirectoryAdapter, words: Iterable<string>): Promise<void> {
    await adapter.write('etherpk', DICTIONARY_FILE, dictionaryFileText(words))
}
