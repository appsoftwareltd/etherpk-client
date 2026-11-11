import { describe, expect, it } from 'vitest'
import {
    ALL_GRAPHS_GET,
    FOLDER_UNAVAILABLE_REASON,
    graphChoicePanels,
    newSyncedGraphStep,
    type ChoiceServer,
    type GraphChoiceInput,
} from './graph-choice-panels'
import type { ServerAuthState } from './graph-picker-helpers'

const CORPORATE = {
    trialUrl: 'https://www.example.com/register?redirect=%2Fbilling',
    billingUrl: 'https://www.example.com/billing',
    pricingUrl: 'https://www.example.com/pricing',
}

function input(overrides: Partial<GraphChoiceInput> = {}): GraphChoiceInput {
    return { folderSupported: true, managedOffered: true, servers: [], trialUrl: null, billingUrl: null, pricingUrl: null, offer: null, ...overrides }
}

function server(overrides: Partial<ChoiceServer> = {}): ChoiceServer {
    return { kind: 'managed', authState: 'authenticated', syncPlusRequired: false, planEnded: false, createBlockedReason: null, ...overrides }
}

const FREE = server({ syncPlusRequired: true, createBlockedReason: 'Synced graphs need Sync+. Start it from Billing to create one.' })
const ENDED = server({ syncPlusRequired: true, planEnded: true, createBlockedReason: 'Synced graphs need Sync+. Restart it from Billing to create one.' })

describe('the Local Graph panel', () => {
    it('comes first with a button that opens the folder flow where the browser can open folders', () => {
        const panels = graphChoicePanels(input())
        expect(panels.order).toEqual(['local', 'synced'])
        expect(panels.local.button).toEqual({ label: 'Choose a folder', action: { kind: 'open-folder' } })
        expect(panels.local.help).toBe('For a new graph, choose a new, empty folder.')
        expect(panels.local.available).toBe(true)
    })

    it('moves second, with a stated reason and no button, where the browser cannot open folders', () => {
        const panels = graphChoicePanels(input({ folderSupported: false }))
        expect(panels.order).toEqual(['synced', 'local'])
        expect(panels.local.button).toBeNull()
        expect(panels.local.available).toBe(false)
        expect(panels.local.help).toBe(FOLDER_UNAVAILABLE_REASON)
        expect(FOLDER_UNAVAILABLE_REASON).toBe('Needs Chrome or Edge on a computer, or Chrome on Android.')
    })

    it('lists four points', () => {
        expect(graphChoicePanels(input()).local.bullets).toHaveLength(4)
    })
})

describe("the Synced Graph panel's points", () => {
    const points = (encrypted: string) => [
        'Works on your phone and in every browser',
        'Syncs between your devices',
        'Works offline, and syncs when you are back online',
        encrypted,
        'Share a notes graph and collaborate in real time',
        'Keep a Local Mirror as plain Markdown files, in a browser that can open folders',
    ]

    it('are six on Managed Sync, with offline work and the Local Mirror among them', () => {
        expect(graphChoicePanels(input()).synced.bullets).toEqual(points('End-to-end encrypted, so EtherPK cannot read your notes'))
    })

    it('are the same six on a standalone or custom Sync Server, naming the server', () => {
        expect(graphChoicePanels(input({ managedOffered: false })).synced.bullets)
            .toEqual(points('End-to-end encrypted, so the server cannot read your notes'))
    })
})

describe('what every graph gets', () => {
    it('is a short list, the same whatever the browser or the account', () => {
        expect(ALL_GRAPHS_GET).toEqual([
            'Markdown notes with [[wikilinks]] and backlinks',
            'A daily journal',
            'Tasks with priorities and due dates',
            'Kanban boards and maps',
            'PDFs, EBooks and images in your notes',
            'AI agents through the MCP server',
            'Publish pages as a website',
            'Protected Documents, encrypted with a passphrase',
        ])
    })
})

describe('the Synced Graph panel on Managed Sync', () => {
    it('signed out, offers the trial first and sign-in second, and says Sync+ is paid', () => {
        const { synced } = graphChoicePanels(input(CORPORATE))
        expect(synced.primary).toEqual({ label: 'Start free trial', action: { kind: 'link', href: CORPORATE.trialUrl } })
        expect(synced.secondary).toEqual({ label: 'Sign in', action: { kind: 'sign-in' } })
        expect(synced.plan).toEqual({
            text: 'Synced graphs are part of EtherPK Sync+, a paid plan that starts with a free trial.',
            pricingUrl: CORPORATE.pricingUrl,
        })
        expect(synced.storedBy).toBe('Stored by EtherPK Sync+.')
        expect(synced.bullets).toContain('End-to-end encrypted, so EtherPK cannot read your notes')
        expect(synced.reason).toBeNull()
    })

    it('signed out with the connection still held reads the same as a device that never connected', () => {
        const held = graphChoicePanels(input({ ...CORPORATE, servers: [server({ authState: 'signed-out', createBlockedReason: 'You are signed out.' })] }))
        expect(held.synced).toEqual(graphChoicePanels(input(CORPORATE)).synced)
    })

    it('signed out where this Client knows no account site, offers only the sign-in', () => {
        const { synced } = graphChoicePanels(input())
        expect(synced.primary).toEqual({ label: 'Sign in', action: { kind: 'sign-in' } })
        expect(synced.secondary).toBeNull()
        expect(synced.plan).toEqual({ text: 'Synced graphs need an EtherPK account with Sync+.', pricingUrl: null })
    })

    it('signed in without Sync+, sends the trial button to Billing, where Checkout starts', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [FREE] }))
        expect(synced.primary).toEqual({ label: 'Start free trial', action: { kind: 'link', href: CORPORATE.billingUrl } })
        expect(synced.secondary).toBeNull()
        expect(synced.plan?.pricingUrl).toBe(CORPORATE.pricingUrl)
        // The panel says what stands in the way itself, so the gate's sentence is not repeated.
        expect(synced.reason).toBeNull()
    })

    it('names no trial once Sync+ has ended: Checkout gives one only to a first subscription', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [ENDED] }))
        expect(synced.primary).toEqual({ label: 'Restart Sync+', action: { kind: 'link', href: CORPORATE.billingUrl } })
        expect(synced.plan?.text).toBe('Your Sync+ subscription has ended. Restart it to create synced graphs.')
    })

    it('without Sync+ and with no Billing address known, keeps an enabled button and the reason in view', () => {
        const { synced } = graphChoicePanels(input({ servers: [FREE] }))
        expect(synced.primary).toEqual({ label: 'Create a synced graph', action: { kind: 'create-synced' } })
        expect(synced.reason).toBe(FREE.createBlockedReason)
    })

    it('with Sync+, opens the naming dialog and mentions no plan', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [server()] }))
        expect(synced.primary).toEqual({ label: 'Create a synced graph', action: { kind: 'create-synced' } })
        expect(synced.secondary).toBeNull()
        expect(synced.plan).toBeNull()
        expect(synced.reason).toBeNull()
    })

    it('while the account is still being checked, offers creation: the press waits for the answer', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [server({ authState: 'checking' })] }))
        expect(synced.primary.action).toEqual({ kind: 'create-synced' })
        expect(synced.plan).toBeNull()
    })

    it.each<[string, ServerAuthState, string]>([
        ['not answering', 'unavailable', 'sync.example.com could not be reached. Try again when it answers.'],
        ['waiting on the Device Passcode', 'locked', "Enter this device's passcode to create a synced graph on sync.example.com."],
        ['a plan still being confirmed', 'authenticated', 'EtherPK is still confirming your plan, so a synced graph can be created in a moment.'],
        ['a plan that cannot be confirmed', 'authenticated', 'Your plan cannot be confirmed right now, so no synced graph can be created. This page keeps checking.'],
    ])('%s: the button stays enabled and the reason is persistent text', (_name, authState, reason) => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [server({ authState, createBlockedReason: reason })] }))
        expect(synced.primary).toEqual({ label: 'Create a synced graph', action: { kind: 'create-synced' } })
        expect(synced.reason).toBe(reason)
        // Not a Sync+ offer: the account may already have it.
        expect(synced.plan).toBeNull()
    })
})

describe("the Synced Graph panel with the account site's terms", () => {
    // Made-up figures: the real ones are the account site's to state.
    const TERMS = { billingEnabled: true, monthlyPriceDisplay: '¤12.34', billedYearly: false, priceIsLowest: false, trialDays: 9 } as const

    it('states the price and the trial, signed out and for an account without Sync+', () => {
        for (const servers of [[], [FREE]]) {
            const { synced } = graphChoicePanels(input({ ...CORPORATE, servers, offer: TERMS }))
            expect(synced.plan).toEqual({ text: 'Sync+ is ¤12.34 a month after a 9-day free trial.', pricingUrl: CORPORATE.pricingUrl })
            expect(synced.primary.label).toBe('Start free trial')
        }
    })

    it('says the lowest of several prices as "from", and a yearly one as billed yearly', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, offer: { ...TERMS, billedYearly: true, priceIsLowest: true } }))
        expect(synced.plan?.text).toBe('Sync+ is from ¤12.34 a month, billed yearly after a 9-day free trial.')
    })

    it('names no trial where there is none, and the button says Get Sync+', () => {
        for (const servers of [[], [FREE]]) {
            const { synced } = graphChoicePanels(input({ ...CORPORATE, servers, offer: { ...TERMS, trialDays: 0 } }))
            expect(synced.plan?.text).toBe('Sync+ is ¤12.34 a month.')
            expect(synced.primary.label).toBe('Get Sync+')
        }
        // Signed out, the sign-in stays beside it.
        expect(graphChoicePanels(input({ ...CORPORATE, offer: { ...TERMS, trialDays: 0 } })).synced.secondary).toEqual({ label: 'Sign in', action: { kind: 'sign-in' } })
    })

    it('names no trial while Sync+ cannot be bought, as the pricing page does', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, offer: { ...TERMS, billingEnabled: false } }))
        expect(synced.plan?.text).toBe('Sync+ is ¤12.34 a month.')
        expect(synced.primary).toEqual({ label: 'Get Sync+', action: { kind: 'link', href: CORPORATE.trialUrl } })
    })

    it('without the terms, says what it said before they could be read', () => {
        for (const servers of [[], [FREE]]) {
            const { synced } = graphChoicePanels(input({ ...CORPORATE, servers, offer: null }))
            expect(synced.plan).toEqual({
                text: 'Synced graphs are part of EtherPK Sync+, a paid plan that starts with a free trial.',
                pricingUrl: CORPORATE.pricingUrl,
            })
            expect(synced.primary.label).toBe('Start free trial')
        }
    })

    it('offers no trial to an account whose Sync+ ended, whatever the terms', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [ENDED], offer: TERMS }))
        expect(synced.primary.label).toBe('Restart Sync+')
        expect(synced.plan?.text).toBe('Your Sync+ subscription has ended. Restart it to create synced graphs. Sync+ is ¤12.34 a month.')
    })

    it('changes nothing for an account that has Sync+, or on a standalone Sync Server', () => {
        expect(graphChoicePanels(input({ ...CORPORATE, servers: [server()], offer: TERMS })).synced.plan).toBeNull()
        const standalone = graphChoicePanels(input({ managedOffered: false, offer: TERMS })).synced
        expect(standalone.plan).toBeNull()
        expect(JSON.stringify(standalone)).not.toMatch(/Sync\+|trial|12\.34/)
    })
})

describe('the Synced Graph panel on a standalone or custom Sync Server', () => {
    it('with no server held, leads to connecting one and names no plan and no price', () => {
        const { synced } = graphChoicePanels(input({ managedOffered: false }))
        expect(synced.primary).toEqual({ label: 'Connect to a Sync Server', action: { kind: 'connect-server' } })
        expect(synced.secondary).toBeNull()
        expect(synced.plan).toBeNull()
        expect(synced.storedBy).toBe('Stored on your Sync Server.')
        expect(synced.bullets).toContain('End-to-end encrypted, so the server cannot read your notes')
        expect(JSON.stringify(synced)).not.toMatch(/Sync\+|trial|EtherPK/)
    })

    it('with a server that accepts this device, opens the naming dialog', () => {
        const { synced } = graphChoicePanels(input({ managedOffered: false, servers: [server({ kind: 'custom' })] }))
        expect(synced.primary).toEqual({ label: 'Create a synced graph', action: { kind: 'create-synced' } })
        expect(synced.plan).toBeNull()
        expect(JSON.stringify(synced)).not.toMatch(/Sync\+|trial|EtherPK/)
    })

    it.each<[string, ServerAuthState]>([
        ['refused its access token', 'signed-out'],
        ['is not answering', 'unavailable'],
        ['waits on the Device Passcode', 'locked'],
    ])('with a server that %s, keeps the button and says why', (_name, authState) => {
        const reason = 'sync.example.com cannot take a new graph now.'
        const { synced } = graphChoicePanels(input({ managedOffered: false, servers: [server({ kind: 'custom', authState, createBlockedReason: reason })] }))
        expect(synced.primary).toEqual({ label: 'Create a synced graph', action: { kind: 'create-synced' } })
        expect(synced.reason).toBe(reason)
        expect(synced.plan).toBeNull()
    })
})

describe('the Synced Graph panel with several Sync Servers', () => {
    it('offers creation when any one of them can take a graph, even beside a Free managed account', () => {
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [FREE, server({ kind: 'custom' })] }))
        expect(synced.primary.action).toEqual({ kind: 'create-synced' })
        expect(synced.plan).toBeNull()
        // The graph may go on either, so the panel names neither.
        expect(synced.storedBy).toBe('Stored on your Sync Server.')
    })

    it('offers the trial when the managed account lacks Sync+ and no other server can take a graph', () => {
        const blocked = server({ kind: 'custom', authState: 'unavailable', createBlockedReason: 'Not answering.' })
        const { synced } = graphChoicePanels(input({ ...CORPORATE, servers: [FREE, blocked] }))
        expect(synced.primary.label).toBe('Start free trial')
    })

    it('says where to look when none of them can take a graph', () => {
        const blocked = server({ kind: 'custom', authState: 'unavailable', createBlockedReason: 'Not answering.' })
        const { synced } = graphChoicePanels(input({ managedOffered: false, servers: [blocked, { ...blocked, authState: 'locked' }] }))
        expect(synced.primary.action).toEqual({ kind: 'create-synced' })
        expect(synced.reason).toBe("None of your Sync Servers can take a new graph now. Each one's group below says why.")
    })
})

describe('folder support does not change the synced panel', () => {
    it.each([true, false])('folderSupported=%s', (folderSupported) => {
        for (const servers of [[], [FREE], [ENDED], [server()], [server({ kind: 'custom' })]]) {
            for (const managedOffered of [true, false]) {
                const base = input({ ...CORPORATE, managedOffered, servers })
                expect(graphChoicePanels({ ...base, folderSupported }).synced).toEqual(graphChoicePanels(base).synced)
            }
        }
    })
})

describe('arriving on the Graphs page to name a new synced graph', () => {
    const arrival = (servers: Parameters<typeof newSyncedGraphStep>[0]['servers'], overrides: { managedOffered?: boolean; arrivedSignedIn?: boolean } = {}) =>
        newSyncedGraphStep({ managedOffered: true, arrivedSignedIn: false, servers, ...overrides })
    const held = (overrides: Partial<Parameters<typeof newSyncedGraphStep>[0]['servers'][number]> = {}) =>
        ({ kind: 'managed' as const, authState: 'authenticated' as const, createBlockedReason: null, planPending: false, ...overrides })

    it('opens the naming dialog when a server can take the graph', () => {
        expect(arrival([held()])).toBe('open')
        expect(arrival([held({ createBlockedReason: 'Needs Sync+.' }), held({ kind: 'custom' })])).toBe('open')
    })

    it('starts the sign-in on a device that is not signed in to Managed Sync', () => {
        expect(arrival([])).toBe('sign-in')
        expect(arrival([held({ authState: 'signed-out', createBlockedReason: 'Signed out.' })])).toBe('sign-in')
    })

    it('does not start a second sign-in when one has just finished and the device is still signed out', () => {
        expect(arrival([], { arrivedSignedIn: true })).toBe('drop')
        expect(arrival([held({ authState: 'signed-out', createBlockedReason: 'Signed out.' })], { arrivedSignedIn: true })).toBe('drop')
    })

    it('waits while an account check or the plan is still being confirmed', () => {
        expect(arrival([held({ authState: 'checking' })])).toBe('wait')
        expect(arrival([held({ createBlockedReason: 'Still confirming.', planPending: true })])).toBe('wait')
    })

    it('leaves it to the page when the plan, the server or the passcode stands in the way', () => {
        expect(arrival([held({ createBlockedReason: 'Synced graphs need Sync+.' })])).toBe('drop')
        expect(arrival([held({ authState: 'unavailable', createBlockedReason: 'Not answering.' })])).toBe('drop')
        expect(arrival([held({ authState: 'locked', createBlockedReason: 'Enter the passcode.' })])).toBe('drop')
    })

    it('never starts the EtherPK sign-in for a Client that does not offer Managed Sync', () => {
        expect(arrival([], { managedOffered: false })).toBe('drop')
        expect(arrival([held({ kind: 'custom', authState: 'signed-out', createBlockedReason: 'Token refused.' })], { managedOffered: false })).toBe('drop')
    })
})
