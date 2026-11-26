/**
 * Answers the shell when the window of a Native App is about to close (leave-guard.ts), and holds
 * what `CloseDialog.svelte` asks when something would be lost.
 */
import type { NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import { showNotice } from '#lib/activity/notices.js'

import { settleBeforeLeaving } from './leave-guard.js'

class ClosePrompt {
    /** What closing now would lose. Empty when nothing is asked. */
    losses = $state.raw<string[]>([])
    #bridge: NativeBridge | null = null
    #asking = false

    /** Start answering the shell. Returns a function that stops. */
    listen(bridge: NativeBridge): () => void {
        this.#bridge = bridge
        return bridge.on('beforeClose', () => void this.#answer(bridge))
    }

    /**
     * Close, losing what was named. A shell that could not be told keeps the window, so what would be
     * lost is still asked about, and the person is told to close it again.
     */
    async closeAnyway(): Promise<void> {
        const losses = this.losses
        this.losses = []
        try {
            await this.#bridge?.call('shell.closeAnswer', { allow: true })
        } catch (error) {
            console.error('[native] the shell could not be told to close', error)
            this.losses = losses
            showNotice({ id: 'native-close', tone: 'error', text: 'EtherPK could not close the window. Close it again.' })
        }
    }

    keepOpen(): void {
        this.losses = []
    }

    async #answer(bridge: NativeBridge): Promise<void> {
        // A second press of the close button while the first is being settled is the same question.
        if (this.#asking) return
        this.#asking = true
        try {
            const losses = await settleBeforeLeaving()
            this.losses = losses
            await bridge.call('shell.closeAnswer', { allow: losses.length === 0 })
        } catch (error) {
            console.error('[native] the shell could not be answered', error)
        } finally {
            this.#asking = false
        }
    }
}

export const closePrompt = new ClosePrompt()
