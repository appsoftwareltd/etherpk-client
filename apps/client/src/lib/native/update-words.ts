/** What a Native App says about its updates, and what the person can do. */
import type { UpdateStatus } from '@appsoftwareltd/etherpk-native-bridge'

import { formatBytes } from '@appsoftwareltd/etherpk-shared'

export interface UpdateWords {
    text: string
    /** The button, or null when there is nothing to do but wait. */
    action: { label: string; does: 'check' | 'install' | 'download' } | null
}

const CHECK = { label: 'Check for updates', does: 'check' } as const

/** What the This Device tab says. */
export function updateWords(status: UpdateStatus): UpdateWords | null {
    switch (status.state) {
        case 'off':
            return null
        case 'idle':
            return { text: 'No update is waiting.', action: CHECK }
        case 'checking':
            return { text: 'Checking for updates…', action: null }
        case 'available':
            return availableWords(status)
        case 'downloading':
            return { text: downloadingText(status), action: null }
        case 'ready':
            return { text: `EtherPK ${status.version} is ready to install.`, action: { label: 'Restart and update', does: 'install' } }
        case 'failed':
            return { text: 'EtherPK could not get the update. Check your connection, then try again.', action: CHECK }
    }
}

function availableWords(status: Extract<UpdateStatus, { state: 'available' }>): UpdateWords {
    const version = status.required ? `EtherPK ${status.version} is available, and is an important update.` : `EtherPK ${status.version} is available.`
    return status.install
        ? { text: version, action: { label: 'Update', does: 'install' } }
        : { text: `${version} Download the new version, then install the new version over this one. Your notes and settings are kept.`, action: { label: 'Download', does: 'download' } }
}

function downloadingText({ version, received, total }: Extract<UpdateStatus, { state: 'downloading' }>): string {
    return total > 0 ? `Downloading EtherPK ${version}: ${formatBytes(received)} of ${formatBytes(total)}.` : `Downloading EtherPK ${version}…`
}

/** Whether an update is worth a notice of its own: there is something for the person to do. */
export function updateAsks(status: UpdateStatus): status is Extract<UpdateStatus, { state: 'available' | 'ready' }> {
    return status.state === 'available' || status.state === 'ready'
}
