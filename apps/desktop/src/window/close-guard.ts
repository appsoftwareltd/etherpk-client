/**
 * Closing a window without losing work. The page is told and answers when its saves are done. A page
 * that says no shows its own dialog and says yes later. Only when a page does not answer, because it
 * hangs, is the person asked here.
 */

import { CLOSE_ANSWER_WITHIN_MS } from '@appsoftwareltd/etherpk-native-bridge'

/** The page gives its saves less than this (CLOSE_SETTLE_MS), so one that has not answered by now will not. */
export const ANSWER_WITHIN_MS = CLOSE_ANSWER_WITHIN_MS

export interface GuardedWindow {
    /** Tell the page. */
    ask(): void
    /** Whether the page listens: one that has not started, or has crashed, has nothing to save. */
    listens(): boolean
    /** Close, with the page's own unload handlers but no more asking. */
    close(): void
    /** The person's choice when there is no answer: true to close all the same. */
    closeAnyway(): Promise<boolean>
}

export class CloseGuard {
    /** `saving`: the page was told to save because the session is ending, and nothing is closing yet. */
    private state: 'open' | 'asked' | 'saving' | 'refused' | 'closing' = 'open'
    private timer: NodeJS.Timeout | null = null
    private waiting: ((closed: boolean) => void)[] = []

    constructor(private readonly window: GuardedWindow, private readonly within = ANSWER_WITHIN_MS) {}

    /** The window wants to close. True lets it. */
    request(): boolean {
        if (this.state === 'closing') return true
        if (!this.window.listens()) {
            this.finish()
            return true
        }
        // Pressed again while the page is still answering: one question at a time.
        if (this.state !== 'asked') this.ask()
        return false
    }

    private ask(): void {
        this.state = 'asked'
        this.window.ask()
        this.timer = setTimeout(() => void this.noAnswer(), this.within)
    }

    /**
     * The system is ending the session. The page is told to save. A yes from it only says the saves are
     * done, and the window stays: when the session does end the system closes it, and when the person
     * cancels the shutdown it stays open.
     */
    sessionEnding(): void {
        if (this.state !== 'open' || !this.window.listens()) return
        this.state = 'saving'
        this.window.ask()
    }

    answer(allow: boolean): void {
        this.stopTimer()
        if (this.state === 'closing') return
        if (this.state === 'saving' && allow) {
            this.state = 'open'
            return
        }
        if (!allow) {
            this.state = 'refused'
            this.settle(false)
            return
        }
        // Allowed with nothing asked is the page's own "close now", after its dialog.
        this.finish()
        this.window.close()
    }

    private async noAnswer(): Promise<void> {
        this.timer = null
        const close = await this.window.closeAnyway()
        if (this.state !== 'asked') return
        if (close) {
            this.finish()
            this.window.close()
            return
        }
        this.state = 'open'
        this.settle(false)
    }

    private finish(): void {
        this.stopTimer()
        this.state = 'closing'
        this.settle(true)
    }

    private stopTimer(): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
    }

    private settle(closed: boolean): void {
        for (const tell of this.waiting.splice(0)) tell(closed)
    }

    /** Ask to close, and learn whether it will. */
    async closed(): Promise<boolean> {
        if (this.state === 'closing') return true
        const result = new Promise<boolean>((resolve) => this.waiting.push(resolve))
        this.window.close()
        return result
    }
}
