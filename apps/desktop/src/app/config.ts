/**
 * What a build was made with. `pnpm build` writes it from the environment (build.mjs), so the
 * repository holds no deployment's addresses. Left out, the app has no sign-in and no updates.
 */
import { readFile } from 'node:fs/promises'
import type { SignInConfig } from '../auth/oauth.ts'
import { checkedIssuer } from '../auth/oauth.ts'
import type { UpdateKey } from '../update/feed.ts'

export interface AppConfig { signIn: SignInConfig | null; updateFeedUrl: string | null; updateKeys: UpdateKey[]; updateChannel: string }

/** Fixed in the apps people have installed (packages/shared/src/installed-app.ts and managed-service.ts). */
export const SIGN_IN_CLIENT_ID = 'etherpk-installed'
export const SIGN_IN_RESOURCE = 'urn:etherpk:managed-sync'
export const SIGN_IN_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'sync'] as const

interface Built { issuer?: unknown; updateFeedUrl?: unknown; updateKeys?: unknown; updateChannel?: unknown }

function isKey(value: unknown): value is UpdateKey {
    const key = value as Partial<UpdateKey> | null
    return typeof key?.id === 'string' && typeof key.publicKey === 'string'
}

export function parseConfig(text: string): AppConfig {
    const built = JSON.parse(text) as Built
    const issuer = checkedIssuer(built.issuer ?? null)
    if (typeof built.issuer === 'string' && issuer === null) throw new Error('The account issuer of this build is not an origin.')
    const feed = built.updateFeedUrl ?? null
    if (feed !== null && (typeof feed !== 'string' || !feed.startsWith('https://'))) throw new Error('The update feed of this build is not an https address.')
    return {
        signIn: issuer === null ? null : { issuer, clientId: SIGN_IN_CLIENT_ID, resource: SIGN_IN_RESOURCE, scopes: SIGN_IN_SCOPES },
        updateFeedUrl: feed,
        updateKeys: Array.isArray(built.updateKeys) ? built.updateKeys.filter(isKey) : [],
        updateChannel: typeof built.updateChannel === 'string' ? built.updateChannel : 'stable',
    }
}

export async function readConfig(file: string): Promise<AppConfig> {
    return parseConfig(await readFile(file, 'utf8'))
}
