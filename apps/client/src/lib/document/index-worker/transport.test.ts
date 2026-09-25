import { beforeEach, describe, expect, it, vi } from 'vitest'

const sqliteMocks = vi.hoisted(() => ({
    open: vi.fn(),
}))

vi.mock('../index-db-sqlite', () => ({
    openInMemorySqlDb: sqliteMocks.open,
}))

import { memoryDbHost } from './transport'

describe('in-memory index hosts', () => {
    beforeEach(() => {
        sqliteMocks.open.mockReset()
        sqliteMocks.open.mockResolvedValue({
            exec: vi.fn(),
            run: vi.fn(),
            all: vi.fn(),
            close: vi.fn(),
        })
    })

    it('preserves the held reason when memory is an explicitly temporary host', async () => {
        const host = memoryDbHost('held')

        await expect(host.open('g1')).resolves.toMatchObject({
            persisted: false,
            blocked: 'held',
        })
        await expect(host.discard('g1')).resolves.toMatchObject({
            persisted: false,
            blocked: 'held',
        })
    })
})
