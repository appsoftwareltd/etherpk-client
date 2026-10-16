import type { DocumentText, ExtensionDocuments } from '@appsoftwareltd/etherpk-extension-api'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'

import type { ModelConnection } from '../settings/connections'
import type { Turn } from './model'
import { MAX_STEPS, runTurn, type RunTurnInput } from './runner'

const connection: ModelConnection = { id: 'c1', provider: 'anthropic', name: 'Claude', apiKey: 'sk-test', address: '', defaultModel: 'fake' }

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const finish = (unified: 'stop' | 'tool-calls') => ({ type: 'finish' as const, finishReason: { unified, raw: undefined }, usage })

/** A model step that writes `text`. */
function says(...pieces: string[]) {
    return {
        stream: simulateReadableStream({
            chunks: [{ type: 'text-start' as const, id: 't' }, ...pieces.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })), { type: 'text-end' as const, id: 't' }, finish('stop')],
        }),
    }
}

/** A model step that calls a tool. */
function calls(toolName: string, input: unknown) {
    return { stream: simulateReadableStream({ chunks: [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName, input: JSON.stringify(input) }, finish('tool-calls')] }) }
}

function documents(texts: Record<string, string>): ExtensionDocuments {
    const read = vi.fn(async (name: string): Promise<DocumentText | null> => (name in texts ? { name, kind: 'page', aliases: [], text: texts[name], truncated: false } : null))
    return {
        list: async () => ({ documents: [], total: 0, hasMore: false }),
        read,
        links: async () => [],
        search: async () => ({ results: [], total: 0, hasMore: false }),
        backlinks: async () => [],
        formatGuide: () => '### Document syntax',
        tasks: async () => ({ tasks: [], total: 0, hasMore: false }),
    }
}

function turn(over: Partial<Turn> = {}): Turn {
    return {
        id: 't1',
        question: 'What should I plant?',
        images: [],
        answer: '',
        connectionId: 'c1',
        modelId: 'fake',
        modelLabel: 'Fake',
        grant: 'document',
        webSearch: false,
        tools: [],
        sources: [],
        status: 'streaming',
        askedAt: 0,
        saved: false,
        ...over,
    }
}

function input(model: MockLanguageModelV4, over: Partial<RunTurnInput> = {}): RunTurnInput {
    return {
        history: [],
        turn: turn(),
        home: 'Garden',
        connection,
        model: { id: 'fake', label: 'Fake', images: true, tools: true },
        documents: documents({ Garden: '- water the beans' }),
        block: null,
        webSearch: false,
        signal: new AbortController().signal,
        prepareImage: async (image) => image,
        today: '2026-10-15',
        changed: vi.fn(),
        providerModel: async () => ({ model, tools: {} }),
        ...over,
    }
}

describe('running a turn of an Agent Chat (ADR 0147)', () => {
    it("streams the answer into the turn, with the home document in the model's instructions", async () => {
        const model = new MockLanguageModelV4({ doStream: says('Plant ', 'beans.') })
        const run = input(model)
        await runTurn(run)
        expect(run.turn.answer).toBe('Plant beans.')
        expect(run.turn.status).toBe('done')
        const prompt = model.doStreamCalls[0].prompt
        expect(prompt[0]).toMatchObject({ role: 'system' })
        expect(JSON.stringify(prompt[0])).toContain('- water the beans')
        expect(JSON.stringify(prompt[0])).toContain('2026-10-15')
        expect(run.turn.context).toEqual({ included: ['Garden'], leftOut: [] })
    })

    it('sends the chat so far, leaving out a turn that failed', async () => {
        const model = new MockLanguageModelV4({ doStream: says('Yes.') })
        const history = [turn({ id: 'a', question: 'First?', answer: 'One.', status: 'done' }), turn({ id: 'b', question: 'Broken?', answer: '', status: 'failed' })]
        await runTurn(input(model, { history, turn: turn({ question: 'Second?' }) }))
        const roles = model.doStreamCalls[0].prompt.map((message) => message.role)
        expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
        expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain('Broken?')
    })

    it('reads the graph through its tools under the whole graph, showing each read as a chip', async () => {
        const model = new MockLanguageModelV4({ doStream: [calls('read_document', { name: 'Kitchen' }), says('Basil grows there.')] })
        const docs = documents({ Garden: '- beans', Kitchen: '- basil' })
        const run = input(model, { turn: turn({ grant: 'graph' }), documents: docs })
        await runTurn(run)
        expect(run.turn.tools).toEqual([{ id: 't1-tool-0', callId: 'call-1', summary: 'Read Kitchen', status: 'done' }])
        expect(run.turn.answer).toBe('Basil grows there.')
        expect(docs.read).toHaveBeenCalledWith('Kitchen')
        expect(model.doStreamCalls[0].tools?.map((tool) => tool.name)).toContain('read_document')
    })

    it('shows a chip for each call when a provider gives two steps’ calls the same id', async () => {
        const model = new MockLanguageModelV4({ doStream: [calls('list_documents', {}), calls('read_document', { name: 'Kitchen' }), says('Done.')] })
        const run = input(model, { turn: turn({ grant: 'graph' }), documents: documents({ Garden: '- beans', Kitchen: '- basil' }) })
        await runTurn(run)
        expect(run.turn.tools.map((tool) => [tool.summary, tool.status])).toEqual([
            ['Listed documents', 'done'],
            ['Read Kitchen', 'done'],
        ])
        expect(new Set(run.turn.tools.map((tool) => tool.id)).size).toBe(2)
    })

    it('takes the tools away for the last step, so a model that keeps reading still answers', async () => {
        const reading = Array.from({ length: MAX_STEPS - 1 }, () => calls('list_documents', {}))
        const model = new MockLanguageModelV4({ doStream: [...reading, says('Fern and ivy.')] })
        const run = input(model, { turn: turn({ grant: 'graph' }), documents: documents({ Garden: '- beans', Kitchen: '- basil' }) })
        await runTurn(run)
        expect(model.doStreamCalls).toHaveLength(MAX_STEPS)
        expect(model.doStreamCalls[0].toolChoice).not.toEqual({ type: 'none' })
        expect(model.doStreamCalls.at(-1)?.toolChoice).toEqual({ type: 'none' })
        expect(run.turn.status).toBe('done')
        expect(run.turn.answer).toBe('Fern and ivy.')
    })

    it('says so when the model ends a turn without answering, rather than showing nothing', async () => {
        const model = new MockLanguageModelV4({ doStream: [calls('list_documents', {}), says()] })
        const run = input(model, { turn: turn({ grant: 'graph' }), documents: documents({ Garden: '- beans' }) })
        await runTurn(run)
        expect(run.turn.status).toBe('failed')
        expect(run.turn.error).toBe('The model finished without an answer. Answer again, or ask a narrower question.')
        expect(run.turn.tools.map((tool) => tool.status)).toEqual(['done'])
    })

    it("sends the person's Agent Instruction in every turn's instructions, under any grant", async () => {
        const model = new MockLanguageModelV4({ doStream: says('Ok.') })
        await runTurn(input(model, { agentInstruction: 'Answer in British English.', turn: turn({ grant: 'nothing' }) }))
        expect(JSON.stringify(model.doStreamCalls[0].prompt[0])).toContain('Answer in British English.')
        const without = new MockLanguageModelV4({ doStream: says('Ok.') })
        await runTurn(input(without, { agentInstruction: '  ' }))
        expect(JSON.stringify(without.doStreamCalls[0].prompt[0])).not.toContain('own instructions')
    })

    it('tells the model where the question is when the person sent no prompt', async () => {
        const model = new MockLanguageModelV4({ doStream: says('Shade suits ferns.') })
        const run = input(model, { turn: turn({ question: '', grant: 'document' }) })
        await runTurn(run)
        const asked = model.doStreamCalls[0].prompt.at(-1)
        expect(asked?.role).toBe('user')
        expect(JSON.stringify(asked)).toContain('This document holds what I want')
        expect(run.turn.answer).toBe('Shade suits ferns.')
    })

    it('gives the model no tools for a narrower grant, or for a model that cannot call them', async () => {
        const narrow = new MockLanguageModelV4({ doStream: says('Ok.') })
        await runTurn(input(narrow, { turn: turn({ grant: 'links' }) }))
        expect(narrow.doStreamCalls[0].tools ?? []).toEqual([])
        const toolless = new MockLanguageModelV4({ doStream: says('Ok.') })
        await runTurn(input(toolless, { turn: turn({ grant: 'graph' }), model: { id: 'fake', label: 'Fake', images: false, tools: false } }))
        expect(toolless.doStreamCalls[0].tools ?? []).toEqual([])
    })

    it('sends an image in the question as the model takes it', async () => {
        const model = new MockLanguageModelV4({ doStream: says('A leaf.') })
        const image = { id: 'i1', name: 'leaf.png', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }
        await runTurn(input(model, { turn: turn({ images: [image] }) }))
        const question = model.doStreamCalls[0].prompt.at(-1)
        expect(question).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'What should I plant?' }, { type: 'file', mediaType: 'image/png' }] })
    })

    it('says a refused key is the key, and keeps what arrived before a failure', async () => {
        const model = new MockLanguageModelV4({
            doStream: async () => {
                throw new APICallError({ message: 'Unauthorized', url: 'https://api.example.com', requestBodyValues: {}, statusCode: 401, isRetryable: false, responseBody: '{"error":{"message":"invalid x-api-key"}}' })
            },
        })
        const run = input(model)
        await runTurn(run)
        expect(run.turn.status).toBe('failed')
        expect(run.turn.error).toContain('refused the key')
        expect(run.turn.error).toContain('invalid x-api-key')
    })

    it('stops when the person stops it, keeping the answer so far', async () => {
        const stop = new AbortController()
        const model = new MockLanguageModelV4({
            doStream: async () => ({
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: 'text-start', id: 't' })
                        controller.enqueue({ type: 'text-delta', id: 't', delta: 'Plant ' })
                        stop.abort()
                    },
                }),
            }),
        })
        const run = input(model, { signal: stop.signal })
        await runTurn(run)
        expect(run.turn.status).toBe('stopped')
    })
})
