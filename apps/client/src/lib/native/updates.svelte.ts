/**
 * Updates of a Native App, as its shell reports them: a notice when there is something to do, and
 * the state the This Device tab shows.
 */
import type { NativeBridge, UpdateStatus } from '@appsoftwareltd/etherpk-native-bridge'

import { dismissNotice, showNotice } from '#lib/activity/notices.js'

import { openExternal } from './links.js'
import { updateAsks, updateWords, type UpdateWords } from './update-words.js'

const NOTICE = 'app-update'
/** The state and version of the notice the person closed, so that it is not shown again at each start. */
const CLOSED_KEY = 'etherpk:app-update-closed'

class AppUpdates {
    status = $state.raw<UpdateStatus>({ state: 'off' })
    #bridge: NativeBridge | null = null

    /** Follow the shell. Returns a function that stops. */
    follow(bridge: NativeBridge): () => void {
        this.#bridge = bridge
        const stop = bridge.on('updateStatus', (status) => this.#take(status))
        bridge.call('updates.status', {}).then((status) => this.#take(status), (error: unknown) => this.#failed(error))
        return stop
    }

    /** Do what a button of `updateWords` says. */
    async run(does: NonNullable<UpdateWords['action']>['does']): Promise<void> {
        const bridge = this.#bridge
        if (!bridge) return
        try {
            if (does === 'check') this.#take(await bridge.call('updates.check', {}))
            else if (does === 'install') await bridge.call('updates.install', {})
            else if (this.status.state === 'available') openExternal(this.status.page)
        } catch (error) {
            this.#failed(error)
        }
    }

    #failed(error: unknown): void {
        console.error('[native] updates', error)
        this.status = { state: 'failed', message: String(error) }
    }

    #take(status: UpdateStatus): void {
        if (status.state === 'failed') console.warn('[native] the update failed:', status.message)
        this.status = status
        if (!updateAsks(status)) return dismissNotice(NOTICE)
        const key = `${status.state} ${status.version}`
        // A closed notice stays closed for that version. An important one is said at each start.
        const important = status.state === 'available' && status.required
        if (!important && closedNotice() === key) return
        const { text, action } = updateWords(status)!
        showNotice({
            id: NOTICE,
            tone: 'info',
            dismissal: 'manual',
            text,
            actions: action ? [{ label: action.label, run: () => this.run(action.does), primary: true, id: 'app-update-action' }] : [],
            ondismiss: () => rememberClosed(key),
        })
    }
}

function closedNotice(): string | null {
    try {
        return localStorage.getItem(CLOSED_KEY)
    } catch {
        return null
    }
}

function rememberClosed(key: string): void {
    try {
        localStorage.setItem(CLOSED_KEY, key)
    } catch {
        // Storage refused: the notice comes back at the next start.
    }
}

export const appUpdates = new AppUpdates()
