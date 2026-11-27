/**
 * The page address's [[Command]]s: Copy link to page, and Go to address…, in the Command Menu, and
 * Go to address… in the Activity Bar's menu, which is how a phone reaches it (its strip has no room
 * for a field). What each does is the workspace's: it knows whether the toolbar shows the field.
 */

import { type CommandRegistry, type ContributionRegistry, registerCommandMenuItem, registerContextMenuItem } from '#lib/surface/index.js'

export const PAGE_COPY_LINK = 'page.copyLink'
export const PAGE_GO_TO_ADDRESS = 'page.goToAddress'

/** The words a person reads for the two Commands. */
export const COPY_LINK_TO_PAGE = 'Copy link to page'
export const GO_TO_ADDRESS = 'Go to address…'

export interface PageAddressCommandDeps {
    /** Put the link to the page in front on the clipboard, and say so. */
    copyLink(): Promise<void>
    /** Let the person read, copy and edit the address: the toolbar's field, or a dialog. */
    goToAddress(): void
}

export function registerPageAddressCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: PageAddressCommandDeps): () => void {
    const disposers = [
        commands.register(PAGE_COPY_LINK, () => deps.copyLink()),
        commands.register(PAGE_GO_TO_ADDRESS, () => deps.goToAddress()),
        registerCommandMenuItem(contributions, {
            id: PAGE_COPY_LINK,
            title: COPY_LINK_TO_PAGE,
            detail: 'To open this page from another program or device',
            icon: 'copy',
            group: 'Go to',
            order: 170,
            keywords: ['link', 'address', 'url', 'copy', 'share', 'etherpk'],
            command: PAGE_COPY_LINK,
        }),
        registerCommandMenuItem(contributions, {
            id: PAGE_GO_TO_ADDRESS,
            title: GO_TO_ADDRESS,
            detail: 'Open a page from its link, web address or agent instruction',
            icon: 'globe',
            group: 'Go to',
            order: 171,
            keywords: ['address', 'url', 'link', 'open', 'paste', 'etherpk', 'reference'],
            command: PAGE_GO_TO_ADDRESS,
        }),
        registerContextMenuItem(contributions, {
            id: PAGE_GO_TO_ADDRESS,
            label: GO_TO_ADDRESS,
            icon: 'globe',
            command: PAGE_GO_TO_ADDRESS,
            // With the workspace's own rows, Settings (180) and Keyboard shortcuts (190), after them.
            order: 195,
            when: (target) => target.kind === 'activity-bar',
        }),
    ]
    return () => {
        for (const dispose of disposers) dispose()
    }
}
