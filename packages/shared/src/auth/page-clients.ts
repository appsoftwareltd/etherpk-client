/**
 * The slices of the Better Auth client that shared account pages call.
 *
 * The Server and Corporate clients are built from different plugin sets, so neither's generated
 * type can be named here. These are structural: both real clients satisfy them, and each one
 * states exactly what its page depends on, which is more useful documentation than a re-exported
 * generated type would be.
 */

/** Better Auth returns `{ data, error }` rather than throwing. */
export interface AuthResult<Data = unknown> {
    data?: Data | null
    error?: { message?: string; code?: string; status?: number } | null
}

export interface PasswordResetAuthClient {
    requestPasswordReset(input: { email: string; redirectTo: string }): Promise<AuthResult>
    resetPassword(input: { newPassword: string; token: string }): Promise<AuthResult>
}

export interface AccountAuthClient {
    /** `password` is the account's current one, which the apps' before hook asks for. */
    changeEmail(input: { newEmail: string; callbackURL: string; password?: string }): Promise<AuthResult>
    changePassword(input: {
        currentPassword: string
        newPassword: string
        revokeOtherSessions?: boolean
    }): Promise<AuthResult>
    sendVerificationEmail(input: { email: string; callbackURL: string }): Promise<AuthResult>
    revokeOtherSessions(): Promise<AuthResult>
    linkSocial(input: { provider: string; callbackURL: string }): Promise<AuthResult>
    unlinkAccount(input: { providerId: string; accountId?: string }): Promise<AuthResult>
    twoFactor: {
        enable(input: { password: string }): Promise<AuthResult<{ totpURI: string; backupCodes: string[] }>>
        disable(input: { password: string }): Promise<AuthResult>
        verifyTotp(input: { code: string }): Promise<AuthResult>
    }
    passkey: {
        addPasskey(input?: { name?: string }): Promise<AuthResult | undefined>
        deletePasskey(input: { id: string }): Promise<AuthResult>
    }
}

/** One row of the admin user list, narrowed to what the page renders. */
export interface AdminUserRow {
    id: string
    name: string
    email: string
    image?: string | null
    emailVerified: boolean
    role: string
    banned: boolean | null
    banReason: string | null
    banExpires: number | null
    createdAt: Date
}

export interface AdminSessionRow {
    id: string
    token: string
    createdAt: Date
    expiresAt: Date
    ipAddress?: string | null
    userAgent?: string | null
}

export interface AdminAuthClient {
    admin: {
        listUsers(input: { query: Record<string, string | number> }): Promise<
            AuthResult<{ users?: unknown[]; total?: number }>
        >
        banUser(input: { userId: string; banReason?: string; banExpiresIn?: number }): Promise<AuthResult>
        unbanUser(input: { userId: string }): Promise<AuthResult>
        setUserPassword(input: { userId: string; newPassword: string }): Promise<AuthResult>
        removeUser(input: { userId: string }): Promise<AuthResult>
        impersonateUser(input: { userId: string }): Promise<AuthResult>
        listUserSessions(input: { userId: string }): Promise<AuthResult<{ sessions?: unknown[] }>>
        revokeUserSession(input: { sessionToken: string }): Promise<AuthResult>
        revokeUserSessions(input: { userId: string }): Promise<AuthResult>
    }
}
