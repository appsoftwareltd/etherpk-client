import { describe, expect, it, vi } from 'vitest'

import type { ModelConnection } from '../settings/connections'
import { addressProblem } from './catalogue'
import { listModels, ProviderError, providerHeaders, readModelList } from './models'

const connection = (over: Partial<ModelConnection>): ModelConnection => ({ id: 'c1', provider: 'anthropic', name: 'Claude', apiKey: 'sk-test', address: '', defaultModel: '', ...over })

describe('reading each provider’s model list (ADR 0147)', () => {
    it('reads Anthropic’s names and image support, every Claude model taking tools', () => {
        const models = readModelList('anthropic', {
            data: [
                { id: 'claude-fake-1', display_name: 'Claude Fake 1', capabilities: { image_input: { supported: true } } },
                { id: 'claude-text-only', display_name: 'Claude Text', capabilities: { image_input: { supported: false } } },
            ],
        })
        expect(models).toEqual([
            { id: 'claude-fake-1', label: 'Claude Fake 1', images: true, tools: true },
            { id: 'claude-text-only', label: 'Claude Text', images: false, tools: true },
        ])
    })

    it('keeps only OpenAI’s chat models, and reads their abilities from their names', () => {
        const models = readModelList('openai', { data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini-tts' }, { id: 'o1-mini' }, { id: 'gpt-3.5-turbo' }] })
        expect(models).toEqual([
            { id: 'o1-mini', label: 'o1-mini', images: false, tools: false },
            { id: 'gpt-5', label: 'gpt-5', images: true, tools: true },
            { id: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo', images: false, tools: true },
        ])
    })

    it('keeps only the Gemini models that chat', () => {
        const models = readModelList('gemini', {
            models: [
                { name: 'models/gemini-fake-pro', displayName: 'Gemini Fake Pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
                { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/gemini-fake-image', supportedGenerationMethods: ['generateContent'] },
            ],
        })
        expect(models).toEqual([{ id: 'gemini-fake-pro', label: 'Gemini Fake Pro', images: true, tools: true }])
    })

    it('reads OpenRouter’s input kinds and parameters, by name, and leaves out models that write no text', () => {
        const models = readModelList('openrouter', {
            data: [
                { id: 'vendor/zebra', name: 'Zebra', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['temperature'] },
                { id: 'vendor/aardvark', name: 'Aardvark', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'tool_choice'] },
                { id: 'vendor/painter', name: 'Painter', architecture: { input_modalities: ['text'], output_modalities: ['image'] }, supported_parameters: [] },
            ],
        })
        expect(models).toEqual([
            { id: 'vendor/aardvark', label: 'Aardvark', images: true, tools: true },
            { id: 'vendor/zebra', label: 'Zebra', images: false, tools: false },
        ])
    })

    it('takes a local server’s models to use tools and no images', () => {
        expect(readModelList('local', { data: [{ id: 'fake-model:8b' }] })).toEqual([{ id: 'fake-model:8b', label: 'fake-model:8b', images: false, tools: true }])
    })

    it('reads nothing from an answer of the wrong shape', () => {
        expect(readModelList('openrouter', { data: 'nope' })).toEqual([])
        expect(readModelList('anthropic', null)).toEqual([])
    })
})

describe('asking a provider for its models', () => {
    it('sends the key the way each provider takes it, Anthropic with its browser header', () => {
        expect(providerHeaders(connection({}))).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-dangerous-direct-browser-access': 'true' })
        expect(providerHeaders(connection({ provider: 'gemini' }))).toEqual({ 'x-goog-api-key': 'sk-test' })
        expect(providerHeaders(connection({ provider: 'openrouter' }))).toEqual({ authorization: 'Bearer sk-test' })
        expect(providerHeaders(connection({ provider: 'local', apiKey: '' }))).toEqual({})
    })

    it('asks a local server at its own address', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'fake' }] }))) as unknown as typeof fetch
        await listModels(connection({ provider: 'local', address: 'http://localhost:11434/v1/', apiKey: '' }), fetchImpl)
        expect(fetchImpl).toHaveBeenCalledWith('http://localhost:11434/v1/models', expect.anything())
    })

    it('says a refused key is the key, and an unreachable local server how to let this page in', async () => {
        const refused = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
        await expect(listModels(connection({}), refused)).rejects.toMatchObject({ kind: 'key', message: expect.stringContaining('refused the key') })
        const offline = vi.fn(async () => {
            throw new TypeError('Failed to fetch')
        }) as unknown as typeof fetch
        const failure = await listModels(connection({ provider: 'local', address: 'http://localhost:11434/v1' }), offline).catch((error) => error)
        expect(failure).toBeInstanceOf(ProviderError)
        expect(failure.message).toContain('OLLAMA_ORIGINS')
    })
})

describe('the addresses a connection may name', () => {
    it('takes a model on this computer at a loopback address only', () => {
        expect(addressProblem('local', 'http://localhost:11434/v1')).toBeNull()
        expect(addressProblem('local', 'http://127.0.0.1:1234/v1')).toBeNull()
        // The content policy cannot name an IPv6 address, so the page cannot reach [::1].
        expect(addressProblem('local', 'http://[::1]:11434/v1')).toMatch(/localhost/)
        expect(addressProblem('local', 'http://192.168.1.20:11434/v1')).toMatch(/localhost/)
    })

    it('takes another server over https only', () => {
        expect(addressProblem('compatible', 'https://models.example.com/v1')).toBeNull()
        expect(addressProblem('compatible', 'http://models.example.com/v1')).toMatch(/https/)
        expect(addressProblem('compatible', 'models.example.com')).toMatch(/full address/)
    })
})
