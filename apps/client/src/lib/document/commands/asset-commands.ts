/**
 * The [[Command]]s an [[Asset Reference]] offers: **download** it, **delete** it, **open** it in
 * its own tab, and - for an image - **copy** it to the clipboard.
 *
 * Commands rather than inline click handlers, for the reason the document Commands are: the
 * three surfaces that offer them — the hover overlay on a rendered image, the trailing icon
 * cluster on a link, and the [[Context Menu]] (which is how they reach touch, where there is no
 * hover) — stay *presentation* over one registry. One implementation, one set of tests, and a
 * keybinding or a [[Command Menu]] row can reach them later without touching any of the three.
 *
 * Each takes an {@link AssetContextMenuTarget}, because these act on a target rather than on
 * whatever happens to be focused.
 *
 * The delete is the involved one; ADR 0054 is the decision it implements. This module owns the
 * *sequence* — identify, count, prove, ask, act — while the rule about what is allowed lives in
 * `asset-delete.ts` and the dialog lives in the workspace. Nothing destructive happens without
 * an answer from the dialog.
 */

import {
    type AssetContextMenuTarget,
    type CommandRegistry,
    type ContributionRegistry,
    type EditableAssetTarget,
    isAssetTarget,
    isEditableAssetTarget,
    registerContextMenuItem,
} from '$lib/surface'
import type { AssetStore, ResolvedAsset } from '$lib/storage/fs/asset-store'
import type { GraphAssetTools } from '$lib/storage/fs/asset-orphans'

import { type AssetDeletePlan, assetUsageNeedles, planAssetDelete } from '../asset-delete'
import { removeAssetReference } from '../view/asset-remove'
import type { RemoteGraphIndex } from '../index-worker/client'

export const ASSET_DOWNLOAD = 'asset.download'
export const ASSET_DELETE = 'asset.delete'
export const ASSET_OPEN = 'asset.open'
export const ASSET_COPY_IMAGE = 'asset.copy-image'

/** What the delete dialog was asked about, and what it may offer. */
export interface AssetDeletePrompt {
    /** What to call the asset in the dialog — the resolved name, else the reference. */
    name: string
    plan: AssetDeletePlan
}

/** What the user chose. `delete` is only ever offered when the plan allows it. */
export type AssetDeleteChoice = 'delete' | 'unlink' | 'cancel'

export interface AssetCommandDeps {
    /** The active asset store, or `null` when no graph is open. */
    store: () => AssetStore | null
    /** Graph-wide asset operations: identity, readiness, and the byte delete itself. */
    tools: () => GraphAssetTools | null
    /** The derived index, which answers the usage count. */
    index: () => RemoteGraphIndex | null
    /** Hand a resolved asset to the browser as a download. */
    download: (url: string, fileName: string) => void
    /**
     * Put a resolving image on the clipboard (`view/clipboard-image.ts`). A PROMISE, not the asset:
     * the clipboard write has to begin inside the click that asked for it, and the bytes arrive
     * later than that on a synced graph.
     */
    copyImage: (asset: Promise<ResolvedAsset>) => Promise<void>
    /** Open the asset's own tab. */
    openAsset: (assetId: string, ref: string) => void
    /** Whether anything registered can show this file in a tab (surface/asset-viewer.ts). */
    canOpen: (ref: string) => boolean
    /** Whether the reference is an image this browser's clipboard can take (`asset-affordances.ts`). */
    canCopyImage: (ref: string) => boolean
    /** Apply an editor change; the workspace supplies the focused editor. */
    applyToEditor: (command: ReturnType<typeof removeAssetReference>) => boolean
    /** Ask the user. Resolves with their choice. */
    promptDelete: (prompt: AssetDeletePrompt) => Promise<AssetDeleteChoice>
    /** Surface a failure (the workspace's status line). */
    onError?: (message: string) => void
    /** Confirm an outcome nothing on screen shows (the same status line). */
    onNotice?: (message: string) => void
}

/**
 * What the asset [[View]] is keyed on: the Asset's identity, carrying an extension.
 *
 * Identity alone would do for keeping one Asset to one tab, but on a [[Server Backend]] that
 * identity is a bare uuid — which names no file type, so the tab could not pick a viewer until
 * the bytes had been fetched and decrypted. Appending the reference's extension keeps the
 * identity (the same bytes always arrive with the same extension) and lets the right viewer
 * mount immediately. A [[Filesystem Backend]] identity is a file name and already carries one.
 */
export function assetViewTarget(assetId: string, ref: string): string {
    if (assetId.includes('.')) return assetId
    const file = ref.split(/[?#]/)[0].split('/').pop() ?? ''
    const dot = file.lastIndexOf('.')
    return dot > 0 ? `${assetId}.${file.slice(dot + 1).toLowerCase()}` : assetId
}

function targetOf(arg: unknown): AssetContextMenuTarget | null {
    const target = arg as AssetContextMenuTarget | undefined
    return target && isAssetTarget(target) ? target : null
}

/**
 * The same, for the one Command that edits the reference rather than reading it. A target with
 * no position came from a surface that only shows the reference (the Backlinks View), where the
 * line to cut is in another document than the one the edit would reach — so the delete declines
 * rather than acting on the wrong place. The Context Menu row is absent there for the same
 * reason; this is the guard behind it.
 */
function editableTargetOf(arg: unknown): EditableAssetTarget | null {
    const target = arg as AssetContextMenuTarget | undefined
    return target && isEditableAssetTarget(target) ? target : null
}

export function registerAssetCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: AssetCommandDeps,
): () => void {
    const disposers: (() => void)[] = []

    /**
     * Run the work and report: `true` when it completed, `false` when it threw (the message goes to
     * the status line). The result is what a surface keys its own confirmation on - an action with
     * no visible effect shows a tick only for a copy that actually landed.
     */
    const guard = async (work: Promise<void>): Promise<boolean> => {
        try {
            await work
            return true
        } catch (err) {
            deps.onError?.((err as Error).message)
            return false
        }
    }

    /** The asset behind a target, or a rejection saying it has gone - the one message every route shares. */
    async function resolveOrExplain(target: AssetContextMenuTarget): Promise<ResolvedAsset> {
        const resolved = await deps.store()?.resolve(target.ref)
        // A missing asset has nothing to hand over. Say so rather than acting on an empty file.
        if (!resolved) throw new Error('That file is no longer in this graph.')
        return resolved
    }

    async function download(target: AssetContextMenuTarget): Promise<void> {
        const resolved = await resolveOrExplain(target)
        deps.download(resolved.url, resolved.name)
    }

    async function copyImage(target: AssetContextMenuTarget): Promise<void> {
        // No `await` before the hand-over: the clipboard is only writable inside the click's user
        // activation, and the asset is resolved (fetched, decrypted) after that has passed. The
        // dependency starts the write now and feeds it the bytes when they come.
        await deps.copyImage(resolveOrExplain(target))
        // A copy changes nothing on screen, so it is the one action that has to say it happened.
        deps.onNotice?.('Image copied.')
    }

    async function open(target: AssetContextMenuTarget): Promise<void> {
        const assetId = deps.tools()?.identify(target.ref)
        if (!assetId) return
        deps.openAsset(assetViewTarget(assetId, target.ref), target.ref)
    }

    async function remove(target: EditableAssetTarget): Promise<void> {
        const tools = deps.tools()
        const assetId = tools?.identify(target.ref)
        if (!tools || !assetId) return

        const index = deps.index()
        const plan = await planAssetDelete({
            // A building index has no answer, and silence must not read as "nothing references
            // it" — `planAssetDelete` treats null as a refusal to destroy bytes.
            usage: async () => (!index || index.isBuilding() ? null : index.assetUsage(assetUsageNeedles(assetId))),
            readiness: () => tools.readyToDeleteBytes(),
        })

        const name = (await deps.store()?.resolve(target.ref))?.name ?? target.ref
        const choice = await deps.promptDelete({ name, plan })
        if (choice === 'cancel') return

        // The reference goes first, and only if it actually went do the bytes follow: an editor
        // that has moved on (the document closed, the line edited away) must not leave a
        // dangling reference behind a destroyed asset.
        if (!deps.applyToEditor(removeAssetReference(target))) return
        if (choice === 'delete' && plan.deleteBytes) await tools.remove([assetId])
    }

    disposers.push(
        commands.register(ASSET_DOWNLOAD, (arg) => {
            const target = targetOf(arg)
            return target ? guard(download(target)) : undefined
        }),
        commands.register(ASSET_OPEN, (arg) => {
            const target = targetOf(arg)
            return target ? guard(open(target)) : undefined
        }),
        commands.register(ASSET_COPY_IMAGE, (arg) => {
            const target = targetOf(arg)
            return target ? guard(copyImage(target)) : undefined
        }),
        commands.register(ASSET_DELETE, (arg) => {
            const target = editableTargetOf(arg)
            return target ? guard(remove(target)) : undefined
        }),
    )

    disposers.push(
        registerContextMenuItem(contributions, {
            id: ASSET_COPY_IMAGE,
            label: 'Copy image',
            command: ASSET_COPY_IMAGE,
            // Ahead of download: the lighter of the two ways to take a picture out of a note.
            order: 5,
            // Only for a picture, and only where the clipboard takes one - the same rule the
            // button clusters apply, so the touch route offers exactly what hover does.
            when: (target) => isAssetTarget(target) && deps.canCopyImage(target.ref),
        }),
        registerContextMenuItem(contributions, {
            id: ASSET_DOWNLOAD,
            label: 'Download',
            command: ASSET_DOWNLOAD,
            order: 10,
            when: isAssetTarget,
        }),
        registerContextMenuItem(contributions, {
            id: ASSET_OPEN,
            label: 'Open in a new tab',
            command: ASSET_OPEN,
            order: 20,
            // Only where something can actually show it — see the asset-viewer registry.
            when: (target) => isAssetTarget(target) && deps.canOpen(target.ref),
        }),
        registerContextMenuItem(contributions, {
            id: ASSET_DELETE,
            label: 'Delete…',
            command: ASSET_DELETE,
            order: 30,
            // Grouped away from the constructive rows, as the document delete is: a destructive
            // row flush against an ordinary one is a mis-click from something permanent.
            separatorBefore: true,
            // Only where the reference can be edited: a surface that merely shows one (the
            // Backlinks View, quoting another document) has no line for the cut to land on.
            when: isEditableAssetTarget,
        }),
    )

    return () => {
        for (const dispose of disposers) dispose()
    }
}
