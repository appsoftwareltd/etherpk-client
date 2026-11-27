/**
 * What the operating system hands to a Native App, carried out: a link, a share, a file or a folder.
 *
 * The shell keeps each one until the page takes it, and gives it once (`launches.take`). It is taken as
 * the app starts, and again whenever the shell says something is waiting.
 */
import type { FileInfo, Launch, NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import { MAX_QUICK_NOTE_LENGTH } from '#lib/document/quick-notes.js'
import { etherpkLinkPath } from '#lib/navigation/page-address.js'
import { withinShareLimits } from '#lib/share/share-limits.js'
import { SHARE_FILES_DROPPED, shareAddress } from '#lib/share/share-post.js'
import { keepSharedFiles } from '#lib/share/shared-files.js'

/** How much of a shared file crosses from the shell at a time. */
export const READ_PART_BYTES = 4 * 1024 * 1024

/**
 * The address in the app of an `etherpk:` link (an [[EtherPK Link]]), or null for one that leads to no
 * page a link may open. Read as Go to address reads one (`navigation/page-address.ts`).
 */
export const linkAddress = etherpkLinkPath

/** What carrying out a launch needs from the app. */
export interface LaunchHandlers {
    /** Go to an address of the app. */
    goto(address: string): Promise<void>
    /** Show a file on its own. */
    openFile(file: FileInfo): Promise<void>
    /** Open a folder as **Open folder** does. */
    openFolder(folder: Extract<Launch, { kind: 'folder' }>['folder']): Promise<void>
    /** Tell the person something could not be opened. */
    say(message: string): void
}

/** Carry out one launch. Resolves with whether it took the app somewhere. */
export async function carryOut(launch: Launch, bridge: NativeBridge, handlers: LaunchHandlers): Promise<boolean> {
    if (launch.kind === 'link') {
        const address = linkAddress(launch.url)
        if (address === null) {
            handlers.say('That link does not lead to anything in EtherPK. Copy the link again from the page it is for.')
            return false
        }
        await handlers.goto(address)
        return true
    }
    if (launch.kind === 'share') {
        await handlers.goto(await receiveShare(launch, bridge))
        return true
    }
    if (launch.kind === 'folder') {
        await handlers.openFolder(launch.folder)
        return true
    }
    await handlers.openFile(launch.file)
    return true
}

/** Keep a share's files on the device, and answer with the address of the page that shows the share. */
export async function receiveShare(share: Extract<Launch, { kind: 'share' }>, bridge: NativeBridge): Promise<string> {
    const { kept, leftOut } = withinShareLimits(share.files)
    const files = kept.length > 0 ? await keepFiles(kept, bridge) : null
    // Nothing reads a shared file again, so the shell need not hold any of them open.
    for (const file of share.files) bridge.call('files.release', { file: file.id }).catch((error: unknown) => console.warn('[native] a shared file was not released', error))
    const words = new Map(Object.entries({ title: share.title, text: share.text, url: share.url }))
    // The page keeps MAX_QUICK_NOTE_LENGTH and says it cut the rest, so it needs only to see there is more.
    return shareAddress({ get: (field: string) => words.get(field)?.slice(0, MAX_QUICK_NOTE_LENGTH * 2) ?? null }, files, leftOut)
}

async function keepFiles(files: readonly FileInfo[], bridge: NativeBridge): Promise<string> {
    try {
        const read: File[] = []
        // One after another: together they would all be in memory twice.
        for (const file of files) read.push(await readFile(file, bridge))
        return await keepSharedFiles(read)
    } catch (error) {
        console.error('[native] the shared files could not be kept', error)
        return SHARE_FILES_DROPPED
    }
}

/** A shared file, read in parts. Rejects when it ends before the size the shell gave. */
async function readFile(file: FileInfo, bridge: NativeBridge): Promise<File> {
    const parts: Uint8Array<ArrayBuffer>[] = []
    for (let offset = 0; offset < file.size; ) {
        const { bytes } = await bridge.call('files.readPart', { file: file.id, offset, length: Math.min(READ_PART_BYTES, file.size - offset) })
        if (bytes.length === 0) throw new Error(`The shared file ended after ${offset} of ${file.size} bytes.`)
        parts.push(bytes)
        offset += bytes.length
    }
    return new File(parts, file.name, { type: file.type, lastModified: file.lastModified })
}

/**
 * Take what is waiting, now and whenever the shell says there is more, one launch at a time in the
 * order they came. `first` resolves once those waiting at the start are carried out, with whether any
 * of them took the app somewhere, so that a start does not also go where it would have.
 */
export function listenForLaunches(bridge: NativeBridge, handlers: LaunchHandlers): { first: Promise<boolean>; stop: () => void } {
    const takeAll = async (): Promise<boolean> => {
        let went = false
        for (const launch of await bridge.call('launches.take', {})) {
            try {
                went = (await carryOut(launch, bridge, handlers)) || went
            } catch (error) {
                console.error(`[native] a ${launch.kind} could not be opened`, error)
                handlers.say(COULD_NOT_OPEN[launch.kind])
            }
        }
        return went
    }
    let queue: Promise<unknown> = Promise.resolve()
    const take = (): Promise<boolean> => {
        const next = queue.then(takeAll).catch((error: unknown) => {
            console.error('[native] what the system handed over could not be taken', error)
            return false
        })
        queue = next
        return next
    }
    const stop = bridge.on('launch', () => void take())
    return { first: take(), stop }
}

const COULD_NOT_OPEN: Record<Launch['kind'], string> = {
    link: 'That link could not be opened. Try it again in a moment.',
    share: 'What you shared did not arrive. Share it to EtherPK again.',
    file: 'That file could not be opened. Open it again, or open its folder from the Graphs page.',
    folder: 'That folder could not be opened. Use Open folder on the Graphs page.',
}
