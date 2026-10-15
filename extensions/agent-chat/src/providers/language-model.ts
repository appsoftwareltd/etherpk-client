/**
 * The AI SDK model for a [[Model Connection]] and a model id, and the provider's own web search
 * tool where the chat may search (ADR 0147). Only the runner imports this module, and it does so
 * when a chat first sends, so none of the AI SDK is in the Client's first download.
 *
 * Every call goes from the browser to the provider with the person's key. Anthropic answers a
 * browser only when told the request comes from one, which `@ai-sdk/anthropic` does not say itself.
 */
import type { LanguageModel, ToolSet } from 'ai'

import type { ModelConnection } from '../settings/connections'
import { baseAddress } from './models'

export interface ProviderModel {
    model: LanguageModel
    /** The provider's own web search, when it was asked for and the provider has one as a tool. */
    tools: ToolSet
}

/** The model to call, and its web search tool when `webSearch` is on and the provider searches. */
export async function providerModel(connection: ModelConnection, modelId: string, webSearch: boolean): Promise<ProviderModel> {
    switch (connection.provider) {
        case 'anthropic': {
            const { createAnthropic } = await import('@ai-sdk/anthropic')
            const anthropic = createAnthropic({ apiKey: connection.apiKey, headers: { 'anthropic-dangerous-direct-browser-access': 'true' } })
            return { model: anthropic(modelId), tools: webSearch ? { web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }) } : {} }
        }
        case 'openai': {
            const { createOpenAI } = await import('@ai-sdk/openai')
            const openai = createOpenAI({ apiKey: connection.apiKey })
            // The Responses API, which `openai(id)` uses, is the one with the web search tool.
            return { model: openai(modelId), tools: webSearch ? { web_search: openai.tools.webSearch({}) } : {} }
        }
        case 'gemini': {
            const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
            const google = createGoogleGenerativeAI({ apiKey: connection.apiKey })
            // No search tool: the catalogue offers none for Gemini (catalogue.ts says why).
            return { model: google(modelId), tools: {} }
        }
        case 'openrouter': {
            const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
            const openrouter = createOpenRouter({ apiKey: connection.apiKey, headers: { 'X-Title': 'EtherPK' } })
            // OpenRouter's web search is a request setting for any model, not a tool.
            return { model: openrouter.chat(modelId, webSearch ? { plugins: [{ id: 'web' }] } : {}), tools: {} }
        }
        default: {
            const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
            const server = createOpenAICompatible({ name: connection.provider === 'local' ? 'local' : 'compatible', baseURL: baseAddress(connection), apiKey: connection.apiKey || undefined })
            return { model: server(modelId), tools: {} }
        }
    }
}
