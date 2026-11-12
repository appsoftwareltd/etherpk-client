/**
 * Deleting the files of a discarded [[Quick Note]] (ADR 0186): a note the person deleted, as
 * opposed to one the move to the journal took, whose references are in the journal.
 *
 * The rule is the trash button's in a document (ADR 0054): a file goes only when nothing else
 * references it, and only when the graph can be sure of that. Another Quick Note, a document, a
 * Protected Document that could not be read, an index still building or a synced graph behind its
 * relay each leave the file where it is, for the orphan scan to offer later. Nothing is asked:
 * the note is already gone, and a file left behind costs storage, never a broken reference.
 */
import type { GraphAssetTools } from '#lib/storage/fs/asset-orphans.js'

import { type AssetDeletePlan, type ProtectedAssetUsage, assetUsageNeedles, planAssetDelete, quickNoteReferences } from './asset-delete'
import type { AssetUsage } from './index-db'
import { quickNoteAssetRefs } from './quick-note-files'

export interface NoteFileCleanupDeps {
    tools: GraphAssetTools | null
    /** The index's count of an asset's references, or null while it cannot answer. */
    usage: (needles: readonly string[]) => Promise<AssetUsage | null>
    protectedUsage?: (needles: readonly string[]) => Promise<ProtectedAssetUsage>
    /** The text of every Quick Note the graph still holds, the discarded ones already gone. */
    noteTexts: () => readonly string[]
}

/** Delete what the discarded notes alone referenced. Resolves with the identities deleted. */
export async function deleteFilesOfDiscardedNotes(noteTexts: readonly string[], deps: NoteFileCleanupDeps): Promise<string[]> {
    const { tools } = deps
    if (!tools) return []
    const deleted: string[] = []
    for (const id of referencedIds(noteTexts, tools)) {
        const needles = assetUsageNeedles(id)
        const plan = await planAssetDelete({
            usage: () => deps.usage(needles),
            ...(deps.protectedUsage ? { protectedUsage: () => deps.protectedUsage!(needles) } : {}),
            readiness: () => tools.readyToDeleteBytes(),
            // The note's own reference went with the note, so any reference found is another's.
            ownReferences: 0,
            quickNoteReferences: () => quickNoteReferences(deps.noteTexts(), needles),
        })
        if (sureNothingElseUsesIt(plan) && (await tools.remove([id])) > 0) deleted.push(id)
    }
    return deleted
}

/** The identity of every asset the notes reference, each once. */
function referencedIds(noteTexts: readonly string[], tools: GraphAssetTools): Set<string> {
    const ids = new Set<string>()
    for (const ref of noteTexts.flatMap(quickNoteAssetRefs)) {
        const id = tools.identify(ref)
        if (id) ids.add(id)
    }
    return ids
}

/** A Protected Document that went unchecked may hold a reference, so the file stays. */
function sureNothingElseUsesIt(plan: AssetDeletePlan): boolean {
    return plan.deleteBytes && !plan.lockedProtected && !plan.unreadProtected
}
