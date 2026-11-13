import { describe, expect, it } from 'vitest'

import { createTelemetry, DEFAULT_TELEMETRY_URL, MAX_BATCH, PER_NAME_CAP, telemetryTarget, type TelemetryTarget } from './usage-events'

const WEBSITE = '0b5f6c1e-3a52-4c1f-9a44-1c2d3e4f5a6b'
const target: TelemetryTarget = { url: 'https://stats.example.com/api/batch', websiteId: WEBSITE }
const START = Date.UTC(2026, 2, 4, 9, 30)

interface Posted {
    type: string
    payload: { website: string; hostname: string; url: string; name: string; timestamp: number; data?: Record<string, string> }
}

function harness(overrides: { target?: TelemetryTarget | null; allowed?: () => boolean } = {}) {
    const batches: { url: string; events: Posted[] }[] = []
    let now = START
    const telemetry = createTelemetry({
        target: overrides.target === undefined ? target : overrides.target,
        allowed: overrides.allowed ?? (() => true),
        now: () => now,
        send: (url, body) => batches.push({ url, events: JSON.parse(body) as Posted[] }),
    })
    const names = () => batches.flatMap((batch) => batch.events.map((event) => event.payload.name))
    return { telemetry, batches, names, advance: (ms: number) => (now += ms) }
}

describe('telemetryTarget', () => {
    it('is off when the deployment does not set an address, or sets it empty', () => {
        expect(telemetryTarget({ url: undefined, websiteId: undefined, dev: false, builtInWebsiteId: WEBSITE })).toBeNull()
        expect(telemetryTarget({ url: undefined, websiteId: WEBSITE, dev: false, builtInWebsiteId: WEBSITE })).toBeNull()
        expect(telemetryTarget({ url: '', websiteId: undefined, dev: false, builtInWebsiteId: WEBSITE })).toBeNull()
        expect(telemetryTarget({ url: '  ', websiteId: WEBSITE, dev: false, builtInWebsiteId: WEBSITE })).toBeNull()
    })

    it("files events under the Client's built-in website id when the address is EtherPK's server", () => {
        expect(telemetryTarget({ url: DEFAULT_TELEMETRY_URL, websiteId: undefined, dev: false, builtInWebsiteId: WEBSITE })).toEqual({
            url: `${DEFAULT_TELEMETRY_URL}/api/batch`,
            websiteId: WEBSITE,
        })
        expect(telemetryTarget({ url: `${DEFAULT_TELEMETRY_URL}/`, websiteId: '', dev: false, builtInWebsiteId: WEBSITE })?.websiteId).toBe(WEBSITE)
    })

    it("does not use the built-in website id in development, where a spec or developer names their own", () => {
        expect(telemetryTarget({ url: DEFAULT_TELEMETRY_URL, websiteId: undefined, dev: true, builtInWebsiteId: WEBSITE })).toBeNull()
        expect(telemetryTarget({ url: 'https://stats.example.com', websiteId: WEBSITE, dev: true, builtInWebsiteId: null })).toEqual(target)
    })

    it("posts to the deployment's own server's batch endpoint, under a path it is served from", () => {
        expect(telemetryTarget({ url: ' https://stats.example.com/ ', websiteId: ` ${WEBSITE} `, dev: false, builtInWebsiteId: null })).toEqual(target)
        expect(telemetryTarget({ url: 'https://example.com/umami', websiteId: WEBSITE, dev: false, builtInWebsiteId: null })?.url).toBe(
            'https://example.com/umami/api/batch',
        )
    })

    it('is off without a usable website id or address, never an error', () => {
        expect(telemetryTarget({ url: DEFAULT_TELEMETRY_URL, websiteId: undefined, dev: false, builtInWebsiteId: null })).toBeNull()
        // Another server does not get EtherPK's website id.
        expect(telemetryTarget({ url: 'https://stats.example.com', websiteId: undefined, dev: false, builtInWebsiteId: WEBSITE })).toBeNull()
        expect(telemetryTarget({ url: 'https://stats.example.com', websiteId: 'not-an-id', dev: false, builtInWebsiteId: null })).toBeNull()
        expect(telemetryTarget({ url: 'javascript:alert(1)', websiteId: WEBSITE, dev: false, builtInWebsiteId: null })).toBeNull()
        expect(telemetryTarget({ url: 'not a url', websiteId: WEBSITE, dev: false, builtInWebsiteId: null })).toBeNull()
    })
})

describe('telemetry', () => {
    const opened = { version: '1.2.3', install: 'browser', deployment: 'self-hosted', layout: 'desktop', theme: 'light' }

    it('holds events until flushed, then sends them in one batch with the time each happened', () => {
        const { telemetry, batches, advance } = harness()
        telemetry.record({ name: 'app_opened', data: opened })
        advance(5_000)
        telemetry.record({ name: 'command.tasks.open' })
        expect(batches).toEqual([])
        telemetry.flush()
        expect(batches).toHaveLength(1)
        expect(batches[0].url).toBe(target.url)
        expect(batches[0].events).toEqual([
            {
                type: 'event',
                payload: { website: WEBSITE, hostname: 'etherpk-client', url: '/app', name: 'app_opened', timestamp: START / 1000, data: opened },
            },
            {
                type: 'event',
                payload: { website: WEBSITE, hostname: 'etherpk-client', url: '/app', name: 'command.tasks.open', timestamp: START / 1000 + 5 },
            },
        ])
    })

    it('sends nothing for an empty queue', () => {
        const { telemetry, batches } = harness()
        telemetry.flush()
        expect(batches).toEqual([])
    })

    it('sends every use, not once a day', () => {
        const { telemetry, names } = harness()
        telemetry.record({ name: 'command.tasks.open' })
        telemetry.record({ name: 'command.tasks.open' })
        telemetry.flush()
        expect(names()).toEqual(['command.tasks.open', 'command.tasks.open'])
    })

    it(`sends a full batch at ${MAX_BATCH} events without waiting`, () => {
        const { telemetry, batches } = harness()
        for (let i = 0; i < MAX_BATCH; i++) telemetry.record({ name: `command.a${i}.open` })
        expect(batches).toHaveLength(1)
        expect(batches[0].events).toHaveLength(MAX_BATCH)
    })

    it(`queues one name at most ${PER_NAME_CAP} times between ticks, so a held key cannot flood it`, () => {
        const { telemetry, names } = harness()
        for (let i = 0; i < PER_NAME_CAP + 10; i++) telemetry.record({ name: 'command.document.findNext' })
        telemetry.record({ name: 'command.tasks.open' })
        telemetry.tick()
        expect(names().filter((name) => name === 'command.document.findNext')).toHaveLength(PER_NAME_CAP)
        expect(names()).toContain('command.tasks.open')
        telemetry.record({ name: 'command.document.findNext' })
        telemetry.flush()
        expect(names().filter((name) => name === 'command.document.findNext')).toHaveLength(PER_NAME_CAP + 1)
    })

    it('drops an event the catalogue does not declare', () => {
        const { telemetry, names } = harness()
        telemetry.record({ name: 'command.tasks.open', data: { page: 'Garden' } })
        telemetry.record({ name: 'page.Garden Notes' })
        telemetry.flush()
        expect(names()).toEqual([])
    })

    it('sends nothing with no collector', () => {
        const { telemetry, batches } = harness({ target: null })
        telemetry.record({ name: 'command.tasks.open' })
        telemetry.flush()
        expect(batches).toEqual([])
        expect(telemetry.available).toBe(false)
    })

    it('queues nothing while not allowed, and drops what was queued when it stops being allowed', () => {
        let allowed = false
        const { telemetry, names } = harness({ allowed: () => allowed })
        telemetry.record({ name: 'command.tasks.open' })
        allowed = true
        telemetry.record({ name: 'command.search.open' })
        allowed = false
        telemetry.flush()
        allowed = true
        telemetry.flush()
        expect(names()).toEqual([])
    })

    it('keeps what it sent for the Privacy tab, and says when it sends', () => {
        const { telemetry } = harness()
        let heard = 0
        telemetry.subscribe(() => heard++)
        telemetry.record({ name: 'settings.privacy' })
        telemetry.flush()
        expect(heard).toBe(1)
        expect(telemetry.sent().map((event) => event.name)).toEqual(['settings.privacy'])
    })

    it('never throws into the feature that reported, whatever sending does', () => {
        const telemetry = createTelemetry({
            target,
            allowed: () => true,
            now: () => 0,
            send: () => {
                throw new Error('blocked')
            },
        })
        telemetry.record({ name: 'command.tasks.open' })
        expect(() => telemetry.flush()).not.toThrow()
    })
})
