/**
 * What an [[Asset Reference]] lets you do, and how a surface asks for it done: **copy** it to the
 * clipboard when it is an image, **download** it, **open** it in a tab where a viewer is
 * registered, and **delete** it.
 *
 * Three surfaces show this set — the trailing icon cluster on a link and the hover overlay on a
 * rendered image (both in the editor's augmentations), and the references [[View]], which renders
 * lines out of other documents with no CodeMirror anywhere near it. The list and the dispatch live
 * here, above all three, so what one offers cannot drift from what another does. The [[Context
 * Menu]] rows come off the same [[Command]]s (`commands/asset-commands.ts`), which is what keeps
 * the touch route equivalent to the buttons rather than a second implementation of them.
 *
 * Nothing here decides anything: every entry names a Command, and the Command decides.
 *
 * No DOM, no CodeMirror — a surface builds its own buttons from this.
 */

import { assetNameFromRef, isImageExt, splitNameExt } from '$lib/storage/fs/asset-store'
import { type AssetContextMenuTarget, canViewAsset, tryGetActiveCommandRegistry, tryGetActiveContributionRegistry } from '$lib/surface'

import { ASSET_COPY_IMAGE, ASSET_DELETE, ASSET_DOWNLOAD, ASSET_OPEN } from './commands/asset-commands'
import type { InlineAction } from './inline-action'
// A browser-capability probe, not DOM: the one thing this module asks of the platform.
import { canCopyImages } from './view/clipboard-image'

/** One entry in the cluster: the shared inline-action shape (`inline-action.ts`), under the asset's name. */
export type AssetAction = InlineAction

/** Whether anything registered can show this file in a tab (surface/asset-viewer.ts). */
export function canOpenAsset(ref: string): boolean {
    const contributions = tryGetActiveContributionRegistry()
    return contributions ? canViewAsset(contributions, ref) : false
}

/**
 * Whether the reference is a picture this browser can put on the clipboard: an [[Asset
 * Reference]] whose extension names an image format, in a browser whose clipboard takes an image
 * at all - a button that can only ever fail is worse than none. Stricter than the embed's
 * `isImageTarget`, which is generous about a missing extension because a hosted picture often has
 * none; here a missing extension means an unknown type, and nothing to promise a PNG from.
 */
export function canCopyImageAsset(ref: string): boolean {
    const name = assetNameFromRef(ref)
    return name !== null && isImageExt(splitNameExt(name).ext) && canCopyImages()
}

export interface AssetActionOptions {
    /** False when the bytes are gone: download is dropped, delete stays. */
    canDownload?: boolean
    /**
     * False on a surface that only *shows* the reference — the Backlinks View quotes another
     * document's line, and the delete edits the active editor, so it would cut the wrong place.
     * The Command refuses such a target anyway (`isEditableAssetTarget`); this keeps a button the
     * user cannot act on off the screen in the first place.
     */
    canDelete?: boolean
}

/**
 * The actions, in order. Copy leads, and only on an image; open is absent when nothing can show
 * the type; copy and download are both absent when there are no bytes to hand over — an asset
 * whose bytes have gone still offers delete, because clearing a dead reference is exactly what a
 * user wants from one.
 */
export function assetActions(ref: string, options: AssetActionOptions = {}): AssetAction[] {
    const hasBytes = options.canDownload !== false
    return [
        ...(hasBytes && canCopyImageAsset(ref)
            ? [{ command: ASSET_COPY_IMAGE, icon: 'copy', label: 'Copy image', confirm: { icon: 'check', label: 'Copied' } }]
            : []),
        ...(hasBytes ? [{ command: ASSET_DOWNLOAD, icon: 'download', label: 'Download' }] : []),
        ...(canOpenAsset(ref) ? [{ command: ASSET_OPEN, icon: 'open-external', label: 'Open in a new tab' }] : []),
        ...(options.canDelete === false ? [] : [{ command: ASSET_DELETE, icon: 'trash', label: 'Delete' }]),
    ]
}

/**
 * Run one of them. Resolves `true` when the Command reports that it did its work (see the guard in
 * `asset-commands.ts`), which is what lets a surface show the action's `confirm`. A registry that
 * has not registered the Command is a no-op, never a throw.
 */
export async function runAssetCommand(command: string, target: AssetContextMenuTarget): Promise<boolean> {
    const commands = tryGetActiveCommandRegistry()
    if (!commands?.has(command)) return false
    return (await commands.execute(command, target)) === true
}
