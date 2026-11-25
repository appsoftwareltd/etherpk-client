/**
 * Usage statistics as a person meets them (ADR 0187): on unless they turn them off, and silent for
 * a browser that sends Global Privacy Control.
 *
 * - **The setting** is one of the person's settings (`#lib/person-settings`), so turning it off
 *   on one device turns it off on the others their account syncs. Only "off" is kept: with
 *   nothing kept, usage statistics are on. Nothing announces them: the switch is at the foot of
 *   Settings' General tab, and the privacy page says what is sent.
 * - **Global Privacy Control** (`navigator.globalPrivacyControl`) is read as "off" without
 *   changing the setting.
 * - **Paused** (the demo): nothing is queued while `paused()` says so.
 *
 * What is sent is `usage-catalogue.ts`; how, `usage-events.ts`.
 */

import type { PersonSettings } from '#lib/person-settings/person-settings.js'

import type { UsageEvent } from './usage-catalogue'
import { createTelemetry, type TelemetryDependencies } from './usage-events'

/** The person's setting. Its only kept value is `off`. */
export const USAGE_STATISTICS_SETTING = 'usage-statistics'

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
    /** Whether the browser sends Global Privacy Control. */
    privacySignal: () => boolean
    /** True while nothing may be counted: the demo. */
    paused: () => boolean
    context: () => AppContext
}

export interface UsageStatistics {
    /** False when this deployment has no collector: there is nothing to show or to set. */
    readonly available: boolean
    state(): UsageStatisticsState
    setEnabled(enabled: boolean): void
    /** Called when the setting changes, here, in another tab or from the person's account. */
    subscribe(listener: () => void): () => void
    /** The app has started: report the open. Runs once. */
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

    const state = (): UsageStatisticsState => {
        if (settings.get(USAGE_STATISTICS_SETTING) === 'off') return 'off'
        return deps.privacySignal() ? 'browser-signal' : 'on'
    }

    const telemetry = createTelemetry({ ...deps, allowed: () => state() === 'on' && !deps.paused() })

    const setEnabled = (enabled: boolean) => settings.set(USAGE_STATISTICS_SETTING, enabled ? null : 'off')

    return {
        available: telemetry.available,
        state,
        setEnabled,
        subscribe: (listener) => settings.subscribe(listener),
        start() {
            if (started || !telemetry.available) return
            started = true
            telemetry.record({ name: 'app_opened', data: { ...deps.context() } })
        },
        record: (event) => {
            if (started) telemetry.record(event)
        },
        flush: () => telemetry.flush(),
        tick: () => telemetry.tick(),
    }
}
