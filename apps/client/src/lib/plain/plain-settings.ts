/**
 * The settings of a [[Plain Folder]] that shape files other people see, kept in its hidden
 * `.etherpk` folder so everyone who opens the folder gets the same (ADR 0197). One file for each
 * setting. A setting nobody has changed has no file, and takes its default.
 *
 * What only this device should decide (whether remote images load, the Layout) is never kept here.
 */
import { type AssetPlacement, DEFAULT_ASSET_PLACEMENT } from './plain-assets'
import type { PlainStateFolder } from './plain-state-folder'

export const SETTINGS = 'settings'
const PASTED_FILES = 'pasted-files'

export interface PlainSettings {
    /** Where a file pasted or dropped into a document is written. */
    pastedFiles: AssetPlacement
}

export const DEFAULT_PLAIN_SETTINGS: PlainSettings = { pastedFiles: DEFAULT_ASSET_PLACEMENT }

const PLACEMENTS: readonly AssetPlacement[] = ['assets', 'beside', 'named']
const isPlacement = (value: unknown): value is AssetPlacement => PLACEMENTS.includes(value as AssetPlacement)

/** The folder's settings. A setting that is absent or not understood takes its default. */
export async function readPlainSettings(folder: PlainStateFolder): Promise<PlainSettings> {
    const settings = { ...DEFAULT_PLAIN_SETTINGS }
    for (const item of await folder.list(SETTINGS)) {
        const value = (typeof item.value === 'object' && item.value !== null ? item.value : {}) as Record<string, unknown>
        if (item.id === PASTED_FILES && isPlacement(value.placement)) settings.pastedFiles = value.placement
    }
    return settings
}

/** Keep where pasted files go. The default is kept by removing the setting's file. */
export async function writePastedFiles(folder: PlainStateFolder, placement: AssetPlacement): Promise<void> {
    if (placement === DEFAULT_ASSET_PLACEMENT) await folder.remove(SETTINGS, PASTED_FILES)
    else await folder.put(SETTINGS, PASTED_FILES, { placement })
}
