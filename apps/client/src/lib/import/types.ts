/**
 * The Import subsystem's shared vocabulary ([[Import]], [[Import Report]]).
 *
 * Converters are pure over an in-memory {@link SourceFile} list and produce a
 * {@link ConvertedGraph} - documents, assets, and the report entries that record every
 * lossy step. Nothing here touches a backend: materialisation is a separate seam so the
 * same converted graph can land on a Filesystem or Server destination.
 */

import type { QuickNote } from '$lib/document/quick-notes'
import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'
import type { ProtectionRecord } from '$lib/crypto'

/** The recognised source formats. `markdown` is an arbitrary folder routed through the Obsidian pipeline. */
export type ImportFormat = 'logseq' | 'obsidian' | 'etherpk' | 'markdown'

/**
 * One file from the picked source folder. `path` is relative to the source root,
 * `/`-separated, WITHOUT the picked folder's own name as a leading segment (the
 * wizard strips it - see `stripRootSegment`). Content is a lazily-readable Blob so a
 * large vault's binaries are not all resident at once; converters read text only for
 * markdown/config files.
 */
export interface SourceFile {
    path: string
    data: Blob
}

/** A converted document ready to materialise. `text` is the full file text including frontmatter. */
export interface ConvertedDocument {
    kind: 'journal' | 'page'
    /** The concept (pages) or ISO date (journals). */
    concept: string
    /** On-disk file name including `.md`. */
    fileName: string
    text: string
}

/** A converted asset ready to materialise under `assets/`. */
export interface ConvertedAsset {
    /** Final on-disk name (content-hashed via `assetFileName`, or verbatim for EtherPK sources). */
    fileName: string
    data: Blob
    /** True when no document references it (imported anyway - data ownership - but counted). */
    unreferenced: boolean
}

/** One entry in the [[Import Report]]: a lossy conversion, drop, rename, or collision. */
export interface ReportEntry {
    category:
        | 'degradation' // converted to the nearest visible markdown (embeds, piped links, fragments...)
        | 'drop' // removed entirely (LOGBOOK, id::, below-normal priorities...)
        | 'rename' // a document or asset changed name (journal date normalisation...)
        | 'collision' // concepts collided and were disambiguated (scoped) or suffixed
        | 'unresolved' // a reference we could not resolve (dangling block ref...)
        | 'unsupported' // a construct left as-is because we do not understand it (queries...)
        | 'unreferenced' // an asset no document references (imported anyway - data ownership)
        | 'not-stored' // an asset the sync server refused to store (over a plan limit, no room)
    /** Concept of the affected document, when there is one (wikilinked in the report page). */
    concept?: string
    detail: string
}

/** A progress tick for the [[Activity Toast]] ("Converting documents: 12 of 480"). */
export interface ImportProgress {
    /** What is being counted, e.g. "Converting documents". Also the key the Activity
     *  adapter matches against its declared phase list, so these strings are a contract. */
    label: string
    done: number
    /** 0 ⇒ an uncounted phase - display the label alone ("Syncing changes…"). */
    total: number
    /** How to render the numbers; `items` when omitted. Asset phases count bytes, because
     *  a graph whose 240 assets include three 400 MB files looks stalled counted by file. */
    unit?: 'items' | 'bytes'
}

export type ImportProgressFn = (progress: ImportProgress) => void

/**
 * The cross-cutting controls every stage of an import threads through: where to report,
 * and when to stop. `breathe` is both the yield point (so Svelte can repaint during a long
 * loop) and the cancel checkpoint - they are the same place, so cancellation is free once
 * yielding is paid for (ADR 0035 §3).
 */
export interface ImportControl {
    onProgress?: ImportProgressFn
    signal?: AbortSignal
    breathe?: (signal?: AbortSignal) => Promise<void>
}

/** Yield-and-check, tolerant of a control that supplies neither. */
export async function breathe(control?: ImportControl): Promise<void> {
    control?.signal?.throwIfAborted()
    if (control?.breathe) await control.breathe(control.signal)
}

/** The output of a converter: everything needed to materialise the new graph. */
export interface ConvertedGraph {
    documents: ConvertedDocument[]
    assets: ConvertedAsset[]
    /** Graph Settings carried from an EtherPK source's `etherpk/settings.json`, when present. */
    settings?: Record<string, unknown>
    /** [[Quick Note]]s carried from an EtherPK source's `etherpk/quick-notes.json`, when present (ADR 0078). */
    quickNotes?: QuickNote[]
    /** The [[Graph Dictionary]] carried from an EtherPK source's `etherpk/dictionary.txt`, when present (ADR 0095). */
    spellingDictionary?: string[]
    /** [[Theme]]s carried from an EtherPK source's `etherpk/theme-<id>.jsonc` files, when present (ADR 0082). */
    themes?: GraphTheme[]
    /**
     * The source graph's passphrase-wrapped Protection Key record from `etherpk/protection.json`
     * (ADR 0093). Adopted as the new graph's own, so its protected documents open with the
     * passphrase they had.
     */
    protection?: ProtectionRecord
    report: ReportEntry[]
}
