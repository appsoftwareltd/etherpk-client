/**
 * What the Mirror and Export tab of the Settings modal needs (ADR 0008, ADR 0092; [[Local Mirror]],
 * [[Export]]).
 *
 * A module rather than a type inside the component, for the same reason as `protection-tab.ts`:
 * both the Settings modal and the workspace that fills it name the shape, and a Svelte instance
 * script cannot export a type.
 *
 * The tab exists only for a synced graph, which is the only kind that has no plain folder of its
 * own; a Filesystem Backend graph IS a folder, and mirroring or exporting it would be copying it
 * to itself. Both halves are the graph as a folder: the mirror keeps one up to date, the export
 * downloads one once, on any browser.
 *
 * The tab is also the only place either can say anything. The mirror runs in the background
 * against a folder nothing else on screen shows, and an export that finished incomplete waits
 * here for a decision, so what they hold, what they could not confirm and why they stopped are
 * reported here rather than being discovered in the folder later.
 */
import { formatBytes } from '@appsoftwareltd/etherpk-shared'

import type { MirrorStatus } from '#lib/storage/synced/local-mirror.js'

export interface ExportEstimate {
    documents: number
    assets: number
    /**
     * The attachments' bytes, from the server's list. The documents' size is not known until each
     * is decrypted, so it is not in here: the attachments are nearly all of an archive that has any.
     */
    bytes: number
}

/**
 * The estimate as the tab words it. The size is named as the attachments', which is what it
 * measures, and is left out when there are none: "about 0 B" for a graph of documents read as
 * though the archive would be empty.
 */
export function describeExportEstimate(estimate: ExportEstimate): string {
    const documents = `${estimate.documents} ${estimate.documents === 1 ? 'document' : 'documents'}`
    if (estimate.assets === 0) return `${documents} and no attachments.`
    const attachments = `${estimate.assets} ${estimate.assets === 1 ? 'attachment' : 'attachments'}`
    return `${documents} and ${attachments}. The attachments are about ${formatBytes(estimate.bytes)}.`
}

export interface ExportTabProps {
    /**
     * What the archive would hold, counted from the server's asset list when the tab opens;
     * null while it is being counted, and `offline` when the server could not be asked, which
     * also means the export cannot run.
     */
    estimate: ExportEstimate | 'offline' | null
    /** An export is under way; the Activity toast reports its progress. */
    running: boolean
    /**
     * An archive that finished with something left out, awaiting the person's decision
     * (ADR 0092, decision 6). The lists say what is missing; Keep hands it over as it is, named
     * as incomplete, and Discard throws it away.
     */
    pending: {
        skipped: string[]
        missingAssets: string[]
        onkeep: () => void
        ondiscard: () => void
    } | null
    /**
     * This graph's download file still on the device from an earlier export, when nothing is
     * using it: the browser without a save picker writes the archive here first, and a page is
     * not told when the download that streams from it has finished, so it is swept later or
     * removed here.
     */
    leftover: { size: number; onremove: () => void } | null
    /**
     * Whether the archive will stream into a file the person names (the save picker, Chromium
     * on a desktop) or be written on the device and then downloaded. Only the wording changes.
     */
    savePicker: boolean
    onexport: () => void
}

export interface MirrorTabProps {
    /**
     * The running mirror's state, or null when this graph has none on this device. Everything
     * the tab reports comes from here, so it never has to be told twice.
     */
    status: MirrorStatus | null
    /**
     * Another tab of this browser holds the folder. Only one tab writes to it, and this one takes
     * over when that one closes, so there is nothing to offer here but Stop - and certainly not
     * the button that sets a mirror up, which would read as though none existed.
     */
    heldElsewhere: boolean
    /**
     * Whether this browser can hand over a folder at all - the File System Access API, which
     * Chromium on a desktop provides and phones and Firefox do not. False replaces the button
     * with the reason, in persistent text rather than a tooltip on a control that cannot be
     * hovered.
     */
    supported: boolean
    /**
     * Pick a folder and start mirroring. The workspace closes the modal first: the pick is a
     * native dialog, and a folder that already has files asks for confirmation in a modal of
     * its own.
     */
    onenable: () => void
    /** Write everything that has changed now, rather than waiting for the debounce. */
    onsync: () => void
    /** Stop mirroring and forget the folder. What is already in it is left alone. */
    onstop: () => void
    /**
     * Clear a pause and carry on. For a lost permission this re-asks for it, which needs the
     * user gesture this click provides; for anything else it simply tries again.
     */
    onresume: () => void
    /** The one-shot half of the tab: the graph as a zip, on any browser. */
    exportGraph: ExportTabProps
}
