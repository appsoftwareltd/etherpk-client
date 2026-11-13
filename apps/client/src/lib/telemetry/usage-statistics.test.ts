import { describe, expect, it } from 'vitest'

import type { NoticeInput } from '#lib/activity/notices.js'
import { createPersonSettings } from '#lib/person-settings/person-settings.js'

import type { TelemetryTarget } from './usage-events'
import { createUsageStatistics, USAGE_STATISTICS_NOTICE_SEEN_KEY, USAGE_STATISTICS_SETTING } from './usage-statistics'

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

/** A storage that refuses everything, as a private window with blocked site data does. */
const blockedStorage = (): Storage => {
    const refuse = () => {
        throw new Error('blocked')
    }
    return { getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse, key: refuse, length: 0 }
}

function harness(options: { target?: TelemetryTarget | null; storage?: Storage; privacySignal?: boolean } = {}) {
    const storage = options.storage ?? memoryStorage()
    const settings = createPersonSettings(() => memoryStorage())
    const notices: NoticeInput[] = []
    const sent: string[] = []
    let paused = false
    const statistics = createUsageStatistics({
        target: options.target === undefined ? target : options.target,
        settings,
        storage: () => storage,
        privacySignal: () => options.privacySignal ?? false,
        paused: () => paused,
        showNotice: (notice) => notices.push(notice),
        now: () => 0,
        context: () => ({ version: '1.2.3', install: 'browser', deployment: 'self-hosted', layout: 'desktop', theme: 'light' }),
        send: (_url, body) => sent.push(...(JSON.parse(body) as { payload: { name: string } }[]).map((event) => event.payload.name)),
    })
    /** What reaches the collector once the queue is sent. */
    const delivered = () => {
        statistics.flush()
        return sent
    }
    return { statistics, storage, settings, notices, delivered, pause: (value: boolean) => (paused = value) }
}

const seen = () => memoryStorage({ [USAGE_STATISTICS_NOTICE_SEEN_KEY]: '1' })

describe('usage statistics', () => {
    it('says so before it sends anything: the first start shows the notice and sends nothing', () => {
        const { statistics, notices, delivered, storage } = harness()
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(notices).toHaveLength(1)
        expect(notices[0].dismissal).toBe('manual')
        expect(delivered()).toEqual([])
        expect(storage.getItem(USAGE_STATISTICS_NOTICE_SEEN_KEY)).not.toBeNull()
    })

    it('sends from the start after the one that showed the notice, with no second notice', () => {
        const { statistics, notices, delivered } = harness({ storage: seen() })
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(notices).toEqual([])
        expect(delivered()).toEqual(['app_opened', 'command.tasks.open'])
    })

    it('starts once, however often it is asked', () => {
        const { statistics, delivered } = harness({ storage: seen() })
        statistics.start()
        statistics.start()
        expect(delivered()).toEqual(['app_opened'])
    })

    it('records nothing before it is started', () => {
        const { statistics, delivered } = harness({ storage: seen() })
        statistics.record({ name: 'command.tasks.open' })
        statistics.start()
        expect(delivered()).toEqual(['app_opened'])
    })

    it('records nothing while paused, as in the demo', () => {
        const { statistics, delivered, pause } = harness({ storage: seen() })
        statistics.start()
        pause(true)
        statistics.record({ name: 'command.tasks.open' })
        pause(false)
        statistics.record({ name: 'command.search.open' })
        expect(delivered()).toEqual(['app_opened', 'command.search.open'])
    })

    it('turns off from the notice, and says where to turn it on again', () => {
        const { statistics, notices, settings } = harness()
        statistics.start()
        void notices[0].actions?.[0].run()
        expect(statistics.state()).toBe('off')
        expect(settings.get(USAGE_STATISTICS_SETTING)).toBe('off')
        expect(notices).toHaveLength(2)
        expect(notices[1].id).toBe(notices[0].id)
        expect(notices[1].text).toMatch(/Settings/)
    })

    it('stops sending the moment the person turns it off, queued events included, and starts again when they turn it on', () => {
        const { statistics, delivered } = harness({ storage: seen() })
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

    it('shows no notice to someone who has it off already, and still owes them one', () => {
        const { statistics, notices, delivered, settings, storage } = harness()
        settings.set(USAGE_STATISTICS_SETTING, 'off')
        statistics.start()
        expect(notices).toEqual([])
        expect(delivered()).toEqual([])
        expect(storage.getItem(USAGE_STATISTICS_NOTICE_SEEN_KEY)).toBeNull()
    })

    it('sends nothing while the browser sends Global Privacy Control, whatever the setting says', () => {
        const { statistics, notices, delivered } = harness({ storage: seen(), privacySignal: true })
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(statistics.state()).toBe('browser-signal')
        expect(notices).toEqual([])
        expect(delivered()).toEqual([])
    })

    it('sends nothing and shows nothing where the device cannot remember the notice was shown', () => {
        const { statistics, notices, delivered } = harness({ storage: blockedStorage() })
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(notices).toEqual([])
        expect(delivered()).toEqual([])
    })

    it('does nothing in a deployment with no collector', () => {
        const { statistics, notices, delivered } = harness({ target: null })
        statistics.start()
        statistics.record({ name: 'command.tasks.open' })
        expect(statistics.available).toBe(false)
        expect(notices).toEqual([])
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
