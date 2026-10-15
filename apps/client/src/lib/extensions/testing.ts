/**
 * Stand-ins for the extension host's tests: a Storage over a map, and the services a workspace
 * would give, over the Client's real registries and bus. Imported by tests only.
 */
import { vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, createEventBus } from '$lib/surface'

import { createPersonSettings, type PersonSettings } from '$lib/person-settings/person-settings'

import type { ClientServices, GraphServices } from './services'
import type { TrustedMarkup } from '$lib/security/trusted-types'

/** A Storage over a plain map, as localStorage behaves. */
export function memoryStorage(initial: Record<string, string> = {}): Storage {
    const values = new Map(Object.entries(initial))
    return {
        get length() {
            return values.size
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    }
}

/** One open graph's services over fresh registries, with the chords already bound listed. */
export function fakeGraphServices(graphId = 'g1') {
    const bindings: { key: string; command: string }[] = [{ key: 'Alt+J', command: 'document.openTodayJournal' }]
    const indexListeners = new Set<() => void>()
    const services: GraphServices = {
        graphId,
        commands: createCommandRegistry(),
        contributions: createContributionRegistry(),
        events: createEventBus(graphId),
        index: {
            allConcepts: () => [],
            linkGraph: async () => ({ concepts: [], links: [] }),
            onUpdated: (listener) => {
                indexListeners.add(listener as () => void)
                return () => indexListeners.delete(listener as () => void)
            },
        },
        layout: { openView: vi.fn(), reveal: vi.fn(), openDocument: vi.fn(), activeDocument: () => null, isDesktop: () => true, openWindow: vi.fn(() => ({ close: vi.fn() })) },
        concepts: { key: (name) => name.toLowerCase(), canonicalName: (name) => name },
        keybindings: {
            add(binding) {
                if (bindings.some((bound) => bound.key === binding.key)) throw new Error(`${binding.key} is bound already.`)
                bindings.push(binding)
                return () => void bindings.splice(bindings.indexOf(binding), 1)
            },
        },
        notify: vi.fn(),
        documents: {
            list: vi.fn(async () => ({ documents: [], total: 0, hasMore: false })),
            read: vi.fn(async () => null),
            links: vi.fn(async () => null),
            search: vi.fn(async () => ({ results: [], total: 0, hasMore: false })),
            backlinks: vi.fn(async () => null),
            formatGuide: () => '### Document syntax',
            tasks: vi.fn(async () => ({ tasks: [], total: 0, hasMore: false })),
        },
        records: (extensionId) => {
            const kept = new Map<string, unknown>()
            const at = (key: string) => `${extensionId}:${key}`
            return {
                get: async <T>(key: string) => kept.get(at(key)) as T | undefined,
                set: async (key, value) => void kept.set(at(key), value),
                remove: async (key) => void kept.delete(at(key)),
                keys: async () => [...kept.keys()].map((key) => key.slice(extensionId.length + 1)).sort(),
            }
        },
        assets: { prepareImage: vi.fn(async (image: Blob) => image), saveImage: vi.fn(async () => '![image](assets/image.webp)') },
        editor: { insertBlock: vi.fn(() => true), openPanel: vi.fn(() => null) },
    }
    return { services, bindings, indexListeners }
}

/** The Client's services, drawing every icon as a tag that names it. */
export function fakeClientServices(storage: Storage = memoryStorage(), settings: PersonSettings = createPersonSettings(() => memoryStorage())): ClientServices {
    return {
        clientVersion: '0.8.54',
        dev: false,
        isDark: () => false,
        // A stand-in for trusted markup: tests read it as the string it is underneath.
        iconSvg: (name) => `<svg data-icon="${name}"/>` as unknown as TrustedMarkup,
        storage,
        settings,
        dialogs: { prompt: vi.fn(async () => undefined) },
        // A sign-in that the service answers at once, with a code and the state it was given.
        signIn: {
            redirectUri: 'https://client.example/extension-sign-in',
            authorize: vi.fn(async (url: string) => ({ code: 'c1', state: new URL(url).searchParams.get('state') ?? '' })),
        },
    }
}
