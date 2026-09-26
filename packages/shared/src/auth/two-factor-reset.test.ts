import { describe, expect, it, vi } from 'vitest'
import { resetUserTwoFactor, type TwoFactorResetStore } from './two-factor-reset'

function store(user: { id: string; twoFactorEnabled?: boolean | null } | null) {
    return {
        internalAdapter: {
            findUserById: vi.fn(async () => user),
            updateUser: vi.fn(async () => user),
        },
        adapter: {
            deleteMany: vi.fn(async () => 1),
        },
    } satisfies TwoFactorResetStore
}

describe('resetUserTwoFactor', () => {
    it('turns the flag off and deletes the secret and backup codes, as a self-service disable does', async () => {
        const users = store({ id: 'user-1', twoFactorEnabled: true })

        await expect(resetUserTwoFactor(users, 'user-1')).resolves.toBe('reset')

        expect(users.internalAdapter.updateUser).toHaveBeenCalledWith('user-1', { twoFactorEnabled: false })
        expect(users.adapter.deleteMany).toHaveBeenCalledWith({
            model: 'twoFactor',
            where: [{ field: 'userId', value: 'user-1' }],
        })
    })

    it('reports a user that does not exist and changes nothing', async () => {
        const users = store(null)

        await expect(resetUserTwoFactor(users, 'missing')).resolves.toBe('not-found')

        expect(users.internalAdapter.updateUser).not.toHaveBeenCalled()
        expect(users.adapter.deleteMany).not.toHaveBeenCalled()
    })
})
