/**
 * Copying a Block's link. Kept apart from `block-view.ts`, which the Headless Client bundles, because
 * the address depends on where the Client runs: its own address in a browser, and in a Native App an
 * `etherpk:` link, since the app's own origin leads nowhere outside it.
 */
import { showNotice } from '#lib/activity/notices.js'
import { isNativeApp } from '#lib/native/bridge.js'
import { THE_ASKER } from '#lib/native/place.js'
import { openingAddress } from '#lib/native/web-address.js'

import { parseGraphAddressPath } from '../navigation/graph-address'
import { type BlockLink, blockLinkUrl } from './block-link'

/** The address of a Block for the clipboard; null outside a graph's address. */
export function blockLinkAddress(link: BlockLink, location: Pick<Location, 'origin' | 'pathname'> = globalThis.location): string | null {
    const graph = parseGraphAddressPath(location.pathname)?.address
    if (!graph) return null
    return isNativeApp() ? openingAddress(blockLinkUrl(graph, link)) : blockLinkUrl(graph, link, location.origin)
}

/** Put the address of the Block a link names on the clipboard, and say so: the clipboard shows nothing. */
export async function copyBlockLink(link: BlockLink): Promise<void> {
    const address = blockLinkAddress(link)
    if (!address) return
    try {
        await navigator.clipboard.writeText(address)
        showNotice({ id: 'block-link-copy', tone: 'info', text: 'Copied a link to the block.' })
    } catch (error) {
        console.error('[block-view] could not copy a link to the block', error)
        const asker = THE_ASKER.charAt(0).toUpperCase() + THE_ASKER.slice(1)
        showNotice({ id: 'block-link-copy', tone: 'error', text: `Could not copy the link to the block. ${asker} did not allow it: try again from the menu.` })
    }
}
