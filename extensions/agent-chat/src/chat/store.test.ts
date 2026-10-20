import type { ExtensionGraphRecords } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it } from 'vitest'

import type { Chat } from './model'
import { chatStore } from './store'

function records(initial: Record<string, unknown> = {}): ExtensionGraphRecords & { kept: Map<string, unknown> } {
    const kept = new Map(Object.entries(initial))
    return {
        kept,
        get: async <T>(key: string) => kept.get(key) as T | undefined,
        set: async (key, value) => void kept.set(key, structuredClone(value)),
        remove: async (key) => void kept.delete(key),
        keys: async () => [...kept.keys()].sort(),
    }
}

const asked: Chat['exchanges'][number] = { id: 't', question: 'Q', images: [], answer: 'A', connectionId: 'c1', modelId: 'fake', modelLabel: 'Fake', grant: 'document', webSearch: false, tools: [], sources: [], status: 'done', askedAt: 1, questionSaved: false, answerSaved: false }

const chat = (over: Partial<Chat> = {}): Chat => ({
    id: 'chat-1',
    title: 'Beans',
    home: 'Garden',
    grant: 'document',
    connectionId: 'c1',
    modelId: 'fake',
    webSearch: false,
    exchanges: [asked],
    createdAt: 1,
    updatedAt: 2,
    ...over,
})

describe("the chats this device keeps for a graph (ADR 0147)", () => {
    it('keeps each chat under its own key, and lists them newest first', async () => {
        const store = chatStore(records())
        await store.save(chat({ id: 'a', updatedAt: 5 }))
        await store.save(chat({ id: 'b', updatedAt: 9 }))
        expect((await store.load()).map((c) => c.id)).toEqual(['b', 'a'])
        await store.remove('b')
        expect((await store.load()).map((c) => c.id)).toEqual(['a'])
    })

    it('reads an answer that was streaming when the tab closed as stopped', async () => {
        const exchange = { id: 't', question: 'Q', images: [], answer: 'Half', connectionId: 'c1', modelId: 'fake', modelLabel: 'Fake', grant: 'document', webSearch: false, tools: [{ id: 'x', callId: 'call-1', summary: 'Read Garden', status: 'running' }], sources: [], status: 'streaming', askedAt: 1, questionSaved: false, answerSaved: false }
        const store = chatStore(records({ 'chat:a': chat({ id: 'a', exchanges: [exchange as Chat['exchanges'][number]] }) }))
        const [loaded] = await store.load()
        expect(loaded.exchanges[0].status).toBe('stopped')
        expect(loaded.exchanges[0].tools[0].status).toBe('failed')
    })

    it('keeps a chat only once something is asked in it', async () => {
        const store = chatStore(records())
        await store.save(chat({ id: 'a', exchanges: [] }))
        expect(await store.load()).toEqual([])
    })

    it('clears a chat with nothing asked in it, kept before, as the chats load', async () => {
        const kept = records({ 'chat:a': chat({ id: 'a', exchanges: [] }), 'chat:b': chat({ id: 'b' }) })
        expect((await chatStore(kept).load()).map((c) => c.id)).toEqual(['b'])
        expect([...kept.kept.keys()]).toEqual(['chat:b'])
    })

    it('reads a chat kept before the two turns of an answer were saved apart, its one flag standing for both', async () => {
        const { exchanges: _exchanges, ...rest } = chat({ id: 'old' })
        const old = { ...rest, turns: [{ ...asked, questionSaved: undefined, answerSaved: undefined, saved: true }] }
        const [loaded] = await chatStore(records({ 'chat:old': old })).load()
        expect(loaded.exchanges).toHaveLength(1)
        expect(loaded.exchanges[0]).toMatchObject({ questionSaved: true, answerSaved: true })
        expect(loaded.exchanges[0]).not.toHaveProperty('saved')
        expect(loaded).not.toHaveProperty('turns')
    })

    it('keeps a chat without a document', async () => {
        const store = chatStore(records())
        await store.save(chat({ id: 'free', home: null }))
        expect((await store.load()).map((c) => [c.id, c.home])).toEqual([['free', null]])
    })

    it("skips a record that is not a chat, and another extension's keys", async () => {
        const store = chatStore(records({ 'chat:bad': { id: 3 }, 'other:x': chat(), 'chat:ok': chat({ id: 'ok' }) }))
        expect((await store.load()).map((c) => c.id)).toEqual(['ok'])
    })
})
