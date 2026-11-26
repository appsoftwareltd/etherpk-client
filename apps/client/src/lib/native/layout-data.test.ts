import { afterEach, describe, expect, it, vi } from 'vitest'

const answer = vi.hoisted(() => ({ signedIn: (): Promise<boolean> => Promise.resolve(true), syncServer: null as string | null }))

vi.mock('./bridge.js', async (original) => ({ ...(await original<object>()), isNativeApp: () => true }))
vi.mock('./session.js', () => ({ nativeSessionAvailable: () => answer.signedIn() }))
vi.mock('./sync-server.js', () => ({ shellSyncServer: () => answer.syncServer }))

const { installedLayoutData } = await import('./layout-data')
const { getNotices, resetNotices } = await import('#lib/activity/notices.js')

describe('the layout data of a Native App', () => {
    afterEach(() => {
        answer.syncServer = null
        resetNotices()
        vi.restoreAllMocks()
    })

    it('says whether someone is signed in', async () => {
        answer.signedIn = () => Promise.resolve(true)
        expect(await installedLayoutData()).toMatchObject({ managedSessionAvailable: true })
    })

    it('opens signed out, logs the fault and says so, when the shell cannot say', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        answer.signedIn = () => Promise.reject(new DOMException('The key store could not be read.', 'OperationError'))
        expect(await installedLayoutData()).toMatchObject({ managedSessionAvailable: false })
        expect(logged).toHaveBeenCalled()
        expect(getNotices().map((one) => one.text)).toEqual([
            'EtherPK could not read whether you are signed in, so it opened signed out. Sign in again to use your synced graphs.',
        ])
    })

    it('leaves the account site\'s pages as built, where the app uses the Sync Server it was built with', async () => {
        const data = await installedLayoutData()
        expect(data).not.toHaveProperty('corporateAccountUrl')
        expect(data).not.toHaveProperty('serverPortalUrl')
    })

    it('offers no account site, and the person\'s own Sync Server\'s pages, where the app was pointed at one', async () => {
        answer.syncServer = 'https://own.example.test'
        const signedIn = vi.fn(() => Promise.resolve(true))
        answer.signedIn = signedIn
        expect(await installedLayoutData()).toMatchObject({
            managedSessionAvailable: false,
            managedService: false,
            serverPortalUrl: 'https://own.example.test/',
            corporateAccountUrl: null,
            corporateBillingUrl: null,
            corporatePricingUrl: null,
            corporateSyncPlusSignUpUrl: null,
            corporateHomeUrl: null,
            syncPlusOffer: null,
        })
        expect(signedIn).not.toHaveBeenCalled()
    })
})
