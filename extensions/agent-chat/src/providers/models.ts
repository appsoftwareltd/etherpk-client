/**
 * Which models a [[Model Connection]] reaches, and what each can take (ADR 0147), read from the
 * provider's own model list with the person's key, from the browser.
 *
 * - Anthropic and OpenRouter say whether a model takes images, and OpenRouter whether it takes
 *   tools. Every Claude model takes tools.
 * - OpenAI's and Gemini's lists say neither, so the names of their chat models are read with a
 *   small table that is updated with releases. A model the table does not know takes no images.
 * - A local or other OpenAI-compatible server lists its models' names only: they are taken to use
 *   tools and no images, and a chat says so when a model refuses.
 *
 * A failure is a {@link ProviderError} whose message tells the person what happened and what to do.
 */
import type { ModelConnection } from '../settings/connections'
import { PROVIDERS } from './catalogue'

export interface ModelInfo {
    /** The id the provider's API takes. */
    id: string
    /** The name shown in the picker. */
    label: string
    /** Whether the model takes images. */
    images: boolean
    /** Whether the model calls tools, which the whole-graph Context Grant needs. */
    tools: boolean
}

export type ProviderErrorKind = 'key' | 'network' | 'limit' | 'other'

/** A provider refused, or could not be reached: the message says what to do. */
export class ProviderError extends Error {
    constructor(
        message: string,
        readonly kind: ProviderErrorKind,
    ) {
        super(message)
        this.name = 'ProviderError'
    }
}

/** A connection's server address without a trailing slash. */
export function baseAddress(connection: Pick<ModelConnection, 'address'>): string {
    return connection.address.trim().replace(/\/+$/, '')
}

/** What a failed answer from a provider means, in the person's words. */
export function errorForStatus(connection: Pick<ModelConnection, 'provider' | 'name'>, status: number, detail = ''): ProviderError {
    const who = connection.name || PROVIDERS[connection.provider].label
    const more = detail ? ` (${detail})` : ''
    if (status === 401 || status === 403) return new ProviderError(`${who} refused the key${more}. Check the key in Settings, Agents.`, 'key')
    if (status === 402) return new ProviderError(`${who} says the account has no credit left${more}. Add credit with the provider, then try again.`, 'limit')
    if (status === 429) return new ProviderError(`${who} is limiting requests just now${more}. Wait a moment, then try again.`, 'limit')
    if (status === 404) return new ProviderError(`${who} does not know this model or address${more}. Choose another model, or check the address in Settings, Agents.`, 'other')
    return new ProviderError(`${who} answered with an error ${status}${more}. Try again, or choose another model.`, 'other')
}

/** What a request that never got an answer means: offline, a wrong address, or a server refusing this page. */
export function unreachable(connection: Pick<ModelConnection, 'provider' | 'name' | 'address'>): ProviderError {
    if (connection.provider === 'local') {
        return new ProviderError(
            `Could not reach the model server at ${baseAddress(connection)}. Check that it is running, and that it allows requests from this page: for Ollama, set OLLAMA_ORIGINS to this page's address, and for LM Studio, switch on CORS.`,
            'network',
        )
    }
    if (connection.provider === 'compatible') return new ProviderError(`Could not reach ${baseAddress(connection)}. Check the address, and that the server allows requests from this page (CORS).`, 'network')
    return new ProviderError(`Could not reach ${connection.name || PROVIDERS[connection.provider].label}. Check your internet connection, then try again.`, 'network')
}

/** The headers a provider's API is called with, the person's key among them. */
export function providerHeaders(connection: ModelConnection): Record<string, string> {
    switch (connection.provider) {
        case 'anthropic':
            // Anthropic answers a browser only when the request says it comes from one.
            return { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
        case 'gemini':
            // In a header rather than the address, so the key is never written into a URL.
            return { 'x-goog-api-key': connection.apiKey }
        default:
            return connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}
    }
}

function listAddress(connection: ModelConnection): string {
    switch (connection.provider) {
        case 'anthropic':
            return 'https://api.anthropic.com/v1/models?limit=1000'
        case 'openai':
            return 'https://api.openai.com/v1/models'
        case 'gemini':
            return 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
        case 'openrouter':
            return 'https://openrouter.ai/api/v1/models'
        default:
            return `${baseAddress(connection)}/models`
    }
}

/** OpenAI models that are not chat models, by a word in their id. */
const OPENAI_NOT_CHAT = /(embedding|tts|whisper|transcribe|audio|realtime|dall-e|image|moderation|instruct|search|babbage|davinci|sora|computer-use)/
/** OpenAI chat models that take images. */
const OPENAI_IMAGES = /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1(?!-mini|-preview)|o3|o4|chatgpt-4o)/
/** OpenAI chat models that cannot call tools. */
const OPENAI_NO_TOOLS = /^(o1-mini|o1-preview)/
/** Gemini models that are not chat models, by a word in their id. */
const GEMINI_NOT_CHAT = /(embedding|imagen|image|tts|native-audio|live|aqa|veo)/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entries(body: unknown, key: string): Record<string, unknown>[] {
    const list = isRecord(body) ? body[key] : undefined
    return Array.isArray(list) ? list.filter(isRecord) : []
}

/** The models a provider's list answer names, read for the provider it came from. */
export function readModelList(provider: ModelConnection['provider'], body: unknown): ModelInfo[] {
    switch (provider) {
        case 'anthropic':
            return entries(body, 'data').flatMap((model) => {
                if (typeof model.id !== 'string') return []
                const capabilities = isRecord(model.capabilities) ? model.capabilities : {}
                const imageInput = isRecord(capabilities.image_input) ? capabilities.image_input.supported : capabilities.image_input
                return [{ id: model.id, label: typeof model.display_name === 'string' ? model.display_name : model.id, images: imageInput !== false, tools: true }]
            })
        case 'openai':
            return entries(body, 'data')
                .flatMap((model) => (typeof model.id === 'string' ? [model.id] : []))
                .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !OPENAI_NOT_CHAT.test(id))
                .sort((a, b) => b.localeCompare(a))
                .map((id) => ({ id, label: id, images: OPENAI_IMAGES.test(id), tools: !OPENAI_NO_TOOLS.test(id) }))
        case 'gemini':
            return entries(body, 'models').flatMap((model) => {
                const id = typeof model.name === 'string' ? model.name.replace(/^models\//, '') : ''
                const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : []
                if (!id.startsWith('gemini') || GEMINI_NOT_CHAT.test(id) || !methods.includes('generateContent')) return []
                return [{ id, label: typeof model.displayName === 'string' ? model.displayName : id, images: true, tools: true }]
            })
        case 'openrouter':
            return entries(body, 'data')
                .flatMap((model) => {
                    if (typeof model.id !== 'string') return []
                    const architecture = isRecord(model.architecture) ? model.architecture : {}
                    const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : []
                    const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : []
                    const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : ['text']
                    if (!outputs.includes('text')) return []
                    return [{ id: model.id, label: typeof model.name === 'string' ? model.name : model.id, images: inputs.includes('image'), tools: parameters.includes('tools') }]
                })
                .sort((a, b) => a.label.localeCompare(b.label))
        default:
            return entries(body, 'data').flatMap((model) => (typeof model.id === 'string' ? [{ id: model.id, label: model.id, images: false, tools: true }] : []))
    }
}

/** Every model a connection reaches, as its provider lists them. */
export async function listModels(connection: ModelConnection, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ModelInfo[]> {
    let response: Response
    try {
        response = await fetchImpl(listAddress(connection), { headers: providerHeaders(connection), signal })
    } catch (error) {
        if (signal?.aborted) throw error
        throw unreachable(connection)
    }
    if (!response.ok) throw errorForStatus(connection, response.status)
    let body: unknown
    try {
        body = await response.json()
    } catch {
        throw new ProviderError(`${connection.name} sent a model list that could not be read.`, 'other')
    }
    return readModelList(connection.provider, body)
}
