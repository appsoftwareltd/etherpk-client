/**
 * The part of Better Auth's context (`await auth.$context`) an administrator's two-factor reset
 * needs. Named structurally so both apps pass their own instance without a shared auth type.
 */
export interface TwoFactorResetStore {
    internalAdapter: {
        findUserById(userId: string): Promise<{ id: string } | null>
        updateUser(userId: string, data: { twoFactorEnabled: boolean }): Promise<unknown>
    }
    adapter: {
        deleteMany(query: { model: string; where: { field: string; value: string }[] }): Promise<number>
    }
}

/**
 * Turn off two-factor authentication for a user who has lost their authenticator and their
 * backup codes. It does what Better Auth's own `/two-factor/disable` does to the user's records,
 * without the password that endpoint asks of the user themself: clear `twoFactorEnabled`, then
 * delete the `twoFactor` row holding the TOTP secret and backup codes.
 * The user signs in with their password alone until they turn 2FA on again.
 */
export async function resetUserTwoFactor(
    store: TwoFactorResetStore,
    userId: string,
): Promise<'reset' | 'not-found'> {
    const user = await store.internalAdapter.findUserById(userId)
    if (!user) return 'not-found'
    await store.internalAdapter.updateUser(userId, { twoFactorEnabled: false })
    await store.adapter.deleteMany({ model: 'twoFactor', where: [{ field: 'userId', value: userId }] })
    return 'reset'
}
