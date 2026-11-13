/**
 * Usage statistics as the browser runs them (ADR 0187): the deployment's Umami server from
 * `PUBLIC_TELEMETRY_URL` and `PUBLIC_TELEMETRY_WEBSITE_ID`, the person's setting, this device's
 * storage, a timer that sends the queue every minute, and a `fetch` that nothing waits for.
 */

import { dev } from '$app/env'
import * as env from '$app/env/public'

import { showNotice } from '#lib/activity/notices.js'
import { DESKTOP_MEDIA_QUERY } from '#lib/layout/breakpoint.js'
import { personSettings } from '#lib/person-settings/person-settings.js'
import { RELEASE_VERSION } from '#lib/release.js'
import { appInstallState } from '#lib/storage/app-install.js'
import { isManagedSyncConfigured } from '#lib/sync/sync-deployment.js'

import { durationBucket, errorKind } from './usage-catalogue'
import { telemetryTarget, type TelemetryTarget } from './usage-events'
import { createUsageStatistics, type UsageStatistics } from './usage-statistics'
import { isDemoPath } from './workspace-usage'

/** How often the queue is sent while the page is open. */
const FLUSH_MS = 60_000

/** What a dev or e2e page may set before it loads (`window.__etherpkTelemetryTarget`). */
interface DevTarget extends TelemetryTarget {
    /** A shorter send interval, so a spec need not wait a minute. */
    flushMs?: number
}

/**
 * Dev and e2e only: a spec names a collector before the page loads, so it can watch what is sent
 * without every other spec meeting the notice. Absent from a production build.
 */
function devTarget(): DevTarget | undefined {
    return dev ? (globalThis as { __etherpkTelemetryTarget?: DevTarget }).__etherpkTelemetryTarget : undefined
}

function deploymentTarget(): TelemetryTarget | null {
    const given = devTarget()
    if (given) return { url: given.url, websiteId: given.websiteId }
    return telemetryTarget({ url: env.PUBLIC_TELEMETRY_URL, websiteId: env.PUBLIC_TELEMETRY_WEBSITE_ID, dev })
}

/** Post a batch. Nothing waits for it, and `keepalive` lets it outlive a page that is closing. */
function send(url: string, body: string): void {
    void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        // No cookie and no referring address go with it.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
    }).catch(() => {
        // Offline, blocked or refused: the counts are lost and nothing else.
    })
}

let shared: UsageStatistics | null = null

/** This page's usage statistics. */
export function usageStatistics(): UsageStatistics {
    shared ??= createUsageStatistics({
        target: typeof window === 'undefined' ? null : deploymentTarget(),
        settings: personSettings(),
        storage: () => (typeof localStorage === 'undefined' ? null : localStorage),
        privacySignal: () => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
        paused: () => isDemoPath(location.pathname),
        showNotice,
        now: () => Date.now(),
        context: () => ({
            version: RELEASE_VERSION,
            install: appInstallState().installed ? 'installed' : 'browser',
            deployment: isManagedSyncConfigured(env) ? 'managed' : 'self-hosted',
            layout: matchMedia(DESKTOP_MEDIA_QUERY).matches ? 'desktop' : 'phone',
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        }),
        send,
    })
    return shared
}

let running = false

/**
 * Start usage statistics for this page: the notice or the open, the timer, the time on screen,
 * and errors nothing else caught. Runs once.
 */
export function startUsageStatistics(): void {
    const statistics = usageStatistics()
    statistics.start()
    if (running || !statistics.available) return
    running = true

    setInterval(() => statistics.tick(), devTarget()?.flushMs ?? FLUSH_MS)

    // How long the app was on screen, reported when it goes off screen, with the queue sent at
    // once: a page that is hidden may never be shown again.
    let visibleSince = Date.now()
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            visibleSince = Date.now()
            return
        }
        statistics.record({ name: 'app_hidden', data: { visible: durationBucket(Date.now() - visibleSince) } })
        statistics.flush()
    })
    window.addEventListener('pagehide', () => statistics.flush())

    // The kind of error only (`TypeError`), never its message or where it happened.
    const reportError = (thrown: unknown) => statistics.record({ name: 'error', data: { version: RELEASE_VERSION, kind: errorKind(thrown) } })
    window.addEventListener('error', (event) => reportError(event.error))
    window.addEventListener('unhandledrejection', (event) => reportError(event.reason))
}
