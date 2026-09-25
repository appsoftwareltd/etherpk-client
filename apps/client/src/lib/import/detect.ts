/**
 * Source-format detection, shown (and overridable) in the import wizard. Order matters:
 * a Logseq graph also has `journals/` + `pages/`, so its config dir is checked first;
 * an EtherPK folder is recognised by its `etherpk/` subdir or by the journals+pages
 * skeleton with ISO-dated journals (a Local Mirror / Export may lack `etherpk/`).
 */

import type { ImportFormat } from './types'

const LOGSEQ_JOURNAL = /^journals\/\d{4}_\d{2}_\d{2}\.md$/i

export function detectFormat(paths: string[]): ImportFormat {
    const hasRootDir = (dir: string) => paths.some((p) => p.startsWith(`${dir}/`))

    if (hasRootDir('logseq')) return 'logseq'
    if (hasRootDir('.obsidian')) return 'obsidian'
    if (hasRootDir('etherpk')) return 'etherpk'
    if (hasRootDir('journals') && hasRootDir('pages')) {
        // A bare journals+pages skeleton: Logseq's underscore-dated journals betray it
        // even without its config dir; otherwise it reads as an EtherPK Export / Mirror.
        return paths.some((p) => LOGSEQ_JOURNAL.test(p)) ? 'logseq' : 'etherpk'
    }
    return 'markdown'
}
