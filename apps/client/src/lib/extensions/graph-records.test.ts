import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'

import { deleteGraphRecords, graphRecords } from './graph-records'

afterEach(async () => {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('etherpk-extension-records')
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
    })
})

describe("an extension's records for one graph on this device (ADR 0147)", () => {
    it('keeps a record by key, structured-cloned, Blobs and all, and lists the keys sorted', async () => {
        const records = graphRecords('graph-1', 'agent-chat')
        await records.set('chat:b', { title: 'Beans', at: 2 })
        await records.set('chat:a', { title: 'Garden', image: new Blob(['png'], { type: 'image/png' }) })
        expect(await records.keys()).toEqual(['chat:a', 'chat:b'])
        const kept = await records.get<{ title: string; image: Blob }>('chat:a')
        expect(kept?.title).toBe('Garden')
        expect(kept?.image.type).toBe('image/png')
        await records.remove('chat:b')
        expect(await records.get('chat:b')).toBeUndefined()
        expect(await records.keys()).toEqual(['chat:a'])
    })

    it("keeps one graph's and one extension's records apart from another's", async () => {
        await graphRecords('graph-1', 'agent-chat').set('chat:a', 1)
        await graphRecords('graph-2', 'agent-chat').set('chat:a', 2)
        await graphRecords('graph-1', 'kanban').set('chat:a', 3)
        expect(await graphRecords('graph-1', 'agent-chat').get('chat:a')).toBe(1)
        expect(await graphRecords('graph-2', 'agent-chat').keys()).toEqual(['chat:a'])
        expect(await graphRecords('graph-1', 'kanban').get('chat:a')).toBe(3)
    })

    it("deletes every extension's records for a graph when the graph leaves the device, and no other graph's", async () => {
        await graphRecords('graph-1', 'agent-chat').set('chat:a', 1)
        await graphRecords('graph-1', 'kanban').set('board', 2)
        await graphRecords('graph-2', 'agent-chat').set('chat:a', 3)
        await deleteGraphRecords('graph-1')
        expect(await graphRecords('graph-1', 'agent-chat').keys()).toEqual([])
        expect(await graphRecords('graph-1', 'kanban').keys()).toEqual([])
        expect(await graphRecords('graph-2', 'agent-chat').get('chat:a')).toBe(3)
    })

    it('refuses a key it would not keep', async () => {
        const records = graphRecords('graph-1', 'agent-chat')
        await expect(records.set('', 1)).rejects.toThrow(/key/)
        await expect(records.set('has space', 1)).rejects.toThrow(/key/)
        await expect(records.set('x'.repeat(201), 1)).rejects.toThrow(/key/)
    })
})
