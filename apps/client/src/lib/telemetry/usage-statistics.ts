/**
 * Usage statistics as a person meets them (ADR 0187): on unless they turn them off, announced
 * once before anything is sent, and silent for a browser that sends Global Privacy Control.
 *
 * - **The setting** is one of the person's settings (`#lib/person-settings`), so turning it off
 *   on one device turns it off on the others their account syncs. Only "off" is kept: with
 *   nothing kept, usage statistics are on.
 * - **The notice** is shown the first time the app starts with usage statistics on. That page
 *   sends nothing, so a person who turns them off from the notice has sent nothing at all. The
 *   device remembers the notice was shown, and a device that cannot remember (blocked site data)
 *   shows no notice and sends nothing.
 * - **Global Privacy Control** (`navigator.globalPrivacyControl`) is read as "off" without
 *   changing the setting, and without a notice, because nothing is sent.
 * - **Paused** (the demo): nothing is queued while `paused()` says so.
 *
 * What is sent is `usage-catalogue.ts`; how, `usage-events.ts`.
 */

import type { NoticeInput } from '#lib/activity/notices.js'
import type { PersonSettings } from '#lib/person-settings/person-settings.js'

import type { UsageEvent } from './usage-catalogue'
import { createTelemetry, type TelemetryDependencies } from './usage-events'

/** The person's setting. Its only kept value is `off`. */
export const USAGE_STATISTICS_SETTING = 'usage-statistics'
/** Kept on the device once the notice has been shown. */
export const USAGE_STATISTICS_NOTICE_SEEN_KEY = 'etherpk:usage-statistics-notice'
export const USAGE_STATISTICS_NOTICE = 'usage-statistics'

/** `browser-signal`: the setting is on, and the browser's Global Privacy Control overrides it. */
export type UsageStatisticsState = 'on' | 'off' | 'browser-signal'

/** What `app_opened` says about the app (see `usage-catalogue.ts`). */
export interface AppContext {
    version: string
    install: 'installed' | 'browser'
    deployment: 'managed' | 'self-hosted'
    layout: 'desktop' | 'phone'
    theme: 'light' | 'dark'
}

export interface UsageStatisticsDependencies extends Omit<TelemetryDependencies, 'allowed'> {
    settings: Pick<PersonSettings, 'get' | 'set' | 'subscribe'>
    /** The device's storage, or null where there is none. May throw, as blocked site data does. */
    storage: () => Storage | null
    /** Whether the browser sends Global Privacy Control. */
    privacySignal: () => boolean
    /** True while nothing may be counted: the demo. */
    paused: () => boolean
    context: () => AppContext
    showNotice: (notice: NoticeInput) => void
}

export interface UsageStatistics {
    /** False when this deployment has no collector: there is nothing to show or to set. */
    readonly available: boolean
    state(): UsageStatisticsState
    setEnabled(enabled: boolean): void
    /** Called when the setting changes, here, in another tab or from the person's account. */
    subscribe(listener: () => void): () => void
    /** The app has started: show the notice if it is owed, else report the open. Runs once. */
    start(): void
    /** Something was used: an event `usage-catalogue.ts` declares. Ignored before `start`. */
    record(event: UsageEvent): void
    /** Send what is queued: the page is being hidden. */
    flush(): void
    /** Send what is queued: the timer. */
    tick(): void
}

export function createUsageStatistics(deps: UsageStatisticsDependencies): UsageStatistics {
    const { settings } = deps
    let started = false
    // True once this page may send: the notice was shown on an earlier start.
    let announced = false

    const state = (): UsageStatisticsState => {
        if (settings.get(USAGE_STATISTICS_SETTING) === 'off') return 'off'
        return deps.privacySignal() ? 'browser-signal' : 'on'
    }

    const telemetry = createTelemetry({ ...deps, allowed: () => announced && state() === 'on' && !deps.paused() })

    const setEnabled = (enabled: boolean) => settings.set(USAGE_STATISTICS_SETTING, enabled ? null : 'off')

    function announce(): void {
        deps.showNotice({
            id: USAGE_STATISTICS_NOTICE,
            tone: 'info',
            // It asks something of the person, so it stays until they close it.
            dismissal: 'manual',
            title: 'Usage statistics',
            text: "EtherPK counts how its features are used, to decide what to work on. It sends the app's version and the names of the commands, tabs and settings you use. It does not send your notes, page names, searches or account.",
            footnote: 'Counting starts the next time you open EtherPK. Settings, under General, turns it off.',
            actions: [
                {
                    label: 'Turn off',
                    id: 'usage-statistics-turn-off',
                    run: () => {
                        setEnabled(false)
                        // In place of the question, and gone by itself: it only reports.
                        deps.showNotice({
                            id: USAGE_STATISTICS_NOTICE,
                            tone: 'info',
                            text: 'Usage statistics are off. Settings, under General, turns them on again.',
                        })
                    },
                },
            ],
        })
    }

    /** Whether this start may send, showing the notice when it is owed. */
    function admit(): boolean {
        try {
            const storage = deps.storage()
            if (!storage) return false
            if (storage.getItem(USAGE_STATISTICS_NOTICE_SEEN_KEY)) return true
            // Off already, by the person or their browser: nothing is sent, so there is nothing
            // to announce. The notice is still owed if that changes.
            if (state() !== 'on') return false
            storage.setItem(USAGE_STATISTICS_NOTICE_SEEN_KEY, '1')
        } catch {
            // The device cannot remember the notice, so it would be owed on every start: nothing
            // is shown and nothing is sent.
            return false
        }
        announce()
        return false
    }

    return {
        available: telemetry.available,
        state,
        setEnabled,
        subscribe: (listener) => settings.subscribe(listener),
        start() {
            if (started || !telemetry.available) return
            started = true
            announced = admit()
            telemetry.record({ name: 'app_opened', data: { ...deps.context() } })
        },
        record: (event) => {
            if (started) telemetry.record(event)
        },
        flush: () => telemetry.flush(),
        tick: () => telemetry.tick(),
    }
}
