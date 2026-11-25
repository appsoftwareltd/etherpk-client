import { describe, expect, it } from 'vitest'

import { createPersonSettings, type PersonSettings } from '#lib/person-settings/person-settings.js'

import type { TelemetryTarget } from './usage-events'
import { createUsageStatistics, USAGE_STATISTICS_SETTING } from './usage-statistics'

const target: TelemetryTarget = { url: 'https://stats.example.com/api/batch', websiteId: '0b5f6c1e-3a52-4c1f-9a44-1c2d3e4f5a6b' }

function memoryStorage(initial: Record<string, string> = {}): Storage {
    const items = new Map(Object.entries(initial))
    return {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => void items.set(key, value),
        removeItem: (key) => void items.delete(key),
        clear: () => items.clear(),
        key: () => null,
        get length() {
            return items.size
        },
    }
}

function harness(options: { target?: TelemetryTarget | null; settings?: PersonSettings; privacySignal?: boolean } = {}) {
    const settings = options.settings ?? createPersonSettings(() => memoryStorage())
    const sent: string[] = []
    let paused = false
    const statistics = createUsageStatistics({
        target: options.target === undefined ? target : options.target,
        settings,
        privacySignal: () => options.privacySignal ?? false,
        paused: () => paused,
        now: () => 0,
        context: () => ({ version: '1.2.3', install: 'browser', deployment: 'self-hosted', layout: 'desktop', theme: 'light' }),
        send: (_url, body) => sent.push(...(JSON.parse(body) as { payload: { name: string } }[]).map((event) => event.payload.name)),
    })
    /** What reaches the collector once the queue is sent. */
    const delivered = () => {
        statistics.flush()
        return sent
    }
    return { statistics, settings, delivered, pause: (value: boolean) => (paused = value) }
}

describe('usage statistics', () => {
    it('sends from the first start: the open, and each use after it', () => {
        const { statistics, delivered } = harness()
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(delivered()).toEqual(['app_opened', 'command.tasks.open'])
    })

    it('starts once, however often it is asked', () => {
        const { statistics, delivered } = harness()
        statistics.start()
        statistics.start()
        expect(delivered()).toEqual(['app_opened'])
    })

    it('records nothing before it is started', () => {
        const { statistics, delivered } = harness()
        statistics.record({ name: 'command.tasks.open' })
        statistics.start()
        expect(delivered()).toEqual(['app_opened'])
    })

    it('records nothing while paused, as in the demo', () => {
        const { statistics, delivered, pause } = harness()
        statistics.start()
        pause(true)
        statistics.record({ name: 'command.tasks.open' })
        pause(false)
        statistics.record({ name: 'command.search.open' })
        expect(delivered()).toEqual(['app_opened', 'command.search.open'])
    })

    it('stops sending the moment the person turns it off, queued events included, and starts again when they turn it on', () => {
        const { statistics, delivered } = harness()
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        statistics.setEnabled(false)
        statistics.record({ name: 'command.search.open' })
        expect(delivered()).toEqual([])
        statistics.setEnabled(true)
        expect(statistics.state()).toBe('on')
        statistics.record({ name: 'command.search.open' })
        expect(delivered()).toEqual(['command.search.open'])
    })

    it('sends nothing for someone who turned it off before this start', () => {
        const { statistics, delivered, settings } = harness()
        settings.set(USAGE_STATISTICS_SETTING, 'off')
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(delivered()).toEqual([])
    })

    it('drops what is queued when the setting the person made on another device arrives', () => {
        const { statistics, delivered, settings } = harness()
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        settings.set(USAGE_STATISTICS_SETTING, 'off')
        expect(delivered()).toEqual([])
    })

    it('sends on a device that refuses storage, which holds no setting', () => {
        const refuse = () => {
            throw new Error('blocked')
        }
        const blocked: Storage = { getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse, key: refuse, length: 0 }
        const { statistics, delivered } = harness({ settings: createPersonSettings(() => blocked) })
        statistics.start()
        expect(delivered()).toEqual(['app_opened'])
    })

    it('sends nothing while the browser sends Global Privacy Control, whatever the setting says', () => {
        const { statistics, delivered } = harness({ privacySignal: true })
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(statistics.state()).toBe('browser-signal')
        expect(delivered()).toEqual([])
    })

    it('does nothing in a deployment with no collector', () => {
        const { statistics, delivered } = harness({ target: null })
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(statistics.available).toBe(false)
        expect(delivered()).toEqual([])
    })

    it('tells a listener when the setting changes', () => {
        const { statistics } = harness()
        let calls = 0
        const stop = statistics.subscribe(() => calls++)
        statistics.setEnabled(false)
        stop()
        statistics.setEnabled(true)
        expect(calls).toBe(1)
    })
})
