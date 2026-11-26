import { describe, expect, it } from 'vitest'
import { INSTALLED_APP_CLIENT_ID } from '../../../../packages/shared/src/installed-app.ts'
import { MANAGED_SYNC_AUDIENCE } from '../../../../packages/shared/src/managed-service.ts'
import { parseConfig, SIGN_IN_CLIENT_ID, SIGN_IN_RESOURCE } from './config.ts'

describe('what a build was made with', () => {
    it('has no sign-in and no updates unless it says so', () => {
        expect(parseConfig('{"issuer":null,"updateFeedUrl":null,"updateKeys":[]}')).toEqual({ signIn: null, updateFeedUrl: null, updateKeys: [], updateChannel: 'stable' })
    })
    it('is refused when it says something the app cannot use', () => {
        for (const text of ['{"issuer":"https://account.example/"}', '{"issuer":"http://account.example"}', '{"updateFeedUrl":"http://x.example"}', '{']) expect(() => parseConfig(text)).toThrow()
    })
    it('signs in as the client the servers know', () => {
        expect([SIGN_IN_CLIENT_ID, SIGN_IN_RESOURCE]).toEqual([INSTALLED_APP_CLIENT_ID, MANAGED_SYNC_AUDIENCE])
        expect(parseConfig('{"issuer":"https://account.example"}').signIn).toMatchObject({ issuer: 'https://account.example', clientId: INSTALLED_APP_CLIENT_ID })
    })
})
