/**
 * The person's Agent Chat settings: their [[Model Connection]]s and whether new chats search the web
 * (ADR 0147). Kept as one record with the person (`personStorage`), so they follow the person to
 * their devices through the account's Settings Vault and never belong to a graph: members of a
 * shared graph never see another member's connections or keys, and an agent the person signs in
 * with the Headless Client never gets the Settings Vault (ADR 0148).
 *
 * A record read from storage may come from an older or newer Client, or be damaged: anything that
 * is not a well-formed connection is dropped rather than trusted.
 */
import type { ExtensionPersonStorage } from '@appsoftwareltd/etherpk-extension-api'

import { isProviderId, type ProviderId } from '../providers/catalogue'

/** The record's key in `personStorage`. */
export const SETTINGS_KEY = 'settings'

/** A person's saved way of reaching one model provider. */
export interface ModelConnection {
    /** Stable across renames, so a chat can name the connection it used. */
    id: string
    provider: ProviderId
    /** What the person calls it; the provider's name until they change it. */
    name: string
    /** The person's key, or empty for a server that takes none. */
    apiKey: string
    /** The server's address, for a local or other OpenAI-compatible server; empty otherwise. */
    address: string
    /** The model a new chat starts on. */
    defaultModel: string
}

export interface AgentChatSettings {
    connections: ModelConnection[]
    /** The connection a new chat starts on, or null for the first. */
    defaultConnection: string | null
    /**
     * Whether a new chat starts with web search on, through the provider's own search. Each chat can
     * switch it on or off for itself. Off until the person turns it on.
     */
    webSearchByDefault: boolean
}

export const EMPTY_SETTINGS: AgentChatSettings = { connections: [], defaultConnection: null, webSearchByDefault: false }

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asConnection(value: unknown): ModelConnection | null {
    if (!isRecord(value)) return null
    const { id, provider, name, apiKey, address, defaultModel } = value
    if (typeof id !== 'string' || id === '' || !isProviderId(provider)) return null
    return {
        id,
        provider,
        name: typeof name === 'string' && name.trim() !== '' ? name : provider,
        apiKey: typeof apiKey === 'string' ? apiKey : '',
        address: typeof address === 'string' ? address : '',
        defaultModel: typeof defaultModel === 'string' ? defaultModel : '',
    }
}

/** The settings as stored, with anything malformed dropped. */
export function readSettings(storage: Pick<ExtensionPersonStorage, 'get'>): AgentChatSettings {
    const raw = storage.get<unknown>(SETTINGS_KEY)
    if (!isRecord(raw)) return { ...EMPTY_SETTINGS, connections: [] }
    const connections = Array.isArray(raw.connections) ? raw.connections.map(asConnection).filter((c): c is ModelConnection => c !== null) : []
    const ids = new Set(connections.map((c) => c.id))
    const unique = connections.filter((c, i) => connections.findIndex((other) => other.id === c.id) === i)
    return {
        connections: unique,
        defaultConnection: typeof raw.defaultConnection === 'string' && ids.has(raw.defaultConnection) ? raw.defaultConnection : null,
        webSearchByDefault: raw.webSearchByDefault === true,
    }
}

export function writeSettings(storage: Pick<ExtensionPersonStorage, 'set'>, settings: AgentChatSettings): void {
    storage.set(SETTINGS_KEY, settings)
}

/** The connection a new chat starts on: the default, or the first, or none. */
export function defaultConnection(settings: AgentChatSettings): ModelConnection | null {
    return settings.connections.find((c) => c.id === settings.defaultConnection) ?? settings.connections[0] ?? null
}

/** The settings with a connection added, or replaced when one has its id. */
export function withConnection(settings: AgentChatSettings, connection: ModelConnection): AgentChatSettings {
    const exists = settings.connections.some((c) => c.id === connection.id)
    const connections = exists ? settings.connections.map((c) => (c.id === connection.id ? connection : c)) : [...settings.connections, connection]
    return { ...settings, connections, defaultConnection: settings.defaultConnection ?? connection.id }
}

/**
 * The settings with a connection made primary: first in every list of connections and models, and
 * the one a new chat starts on. Unchanged for an id no connection has.
 */
export function withPrimary(settings: AgentChatSettings, id: string): AgentChatSettings {
    const primary = settings.connections.find((c) => c.id === id)
    if (!primary) return settings
    return { ...settings, connections: [primary, ...settings.connections.filter((c) => c.id !== id)], defaultConnection: id }
}

/** The settings without a connection; the default moves to the first left. */
export function withoutConnection(settings: AgentChatSettings, id: string): AgentChatSettings {
    const connections = settings.connections.filter((c) => c.id !== id)
    const defaultId = settings.defaultConnection === id ? (connections[0]?.id ?? null) : settings.defaultConnection
    return { ...settings, connections, defaultConnection: defaultId }
}

/** A new connection's id: random, so two devices adding one at once never collide. */
export function newConnectionId(random: () => string = () => crypto.randomUUID()): string {
    return `c-${random()}`
}
