import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNotices, resetNotices } from '#lib/activity/notices.js'

const native = vi.hoisted(() => ({
    installed: true,
    available: true,
    signIn: vi.fn(),
    signOut: vi.fn(async () => {}),
}))
vi.mock('#lib/native/bridge.js', async (original) => ({
    ...(await original<typeof import('#lib/native/bridge.js')>()),
    isNativeApp: () => native.installed,
}))
vi.mock('#lib/native/session.js', () => ({
    nativeSignInAvailable: () => native.available,
    nativeSignIn: native.signIn,
    nativeSignOut: native.signOut,
    nativeAccessToken: vi.fn(async () => null),
}))

const { loadsAgainAfterSignIn, managedSignInOnClick, signInToEtherPK, signOutOfInstalledApp } = await import('./managed-sign-in')
const { managedBearerToken, clearManagedAccessToken } = await import('./managed-token')

const grant = () => ({ accessToken: 'access-1', expiresAt: Date.now() + 15 * 60_000 })
const failure = (name: string) => new DOMException('for the log', name)
const navigated: string[] = []
const navigate = (path: string) => { navigated.push(path) }
const on = (here: string) => ({ navigate, here })

beforeEach(() => {
    Object.assign(native, { installed: true, available: true })
    native.signIn.mockReset()
    native.signOut.mockReset().mockResolvedValue(undefined)
    navigated.length = 0
    clearManagedAccessToken()
    resetNotices()
})
afterEach(() => { vi.restoreAllMocks() })

describe('signing in to EtherPK in a browser', () => {
    it('leaves for the Client’s sign-in route, which comes back', async () => {
        native.installed = false
        await expect(signInToEtherPK('/graphs?tab=sync', { navigate })).resolves.toBe('leaving')
        expect(navigated).toEqual(['/auth/login?redirect=%2Fgraphs%3Ftab%3Dsync'])
        expect(native.signIn).not.toHaveBeenCalled()
    })

    it('lets a sign-in link be followed', () => {
        native.installed = false
        const event = { preventDefault: vi.fn() }
        managedSignInOnClick('/graphs', { navigate })(event as unknown as MouseEvent)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(navigated).toEqual([])
    })
})

describe('signing in to EtherPK in an installed app', () => {
    it('goes through the shell, keeps the token it answers and goes nowhere under /auth', async () => {
        native.signIn.mockResolvedValue(grant())
        await expect(signInToEtherPK('/graph/folder/garden', on('/graph/folder/garden'))).resolves.toBe('signed-in')
        expect(navigated).toEqual([])
        await expect(managedBearerToken()).resolves.toBe('access-1')
        expect(getNotices()).toEqual([])
    })

    it.each(['/graphs', '/graphs?tab=sync', '/graph/sync/018f47a0/d/Garden'])('loads %s again, which was drawn signed out', async (path) => {
        native.signIn.mockResolvedValue(grant())
        await expect(signInToEtherPK(path, on(path))).resolves.toBe('signed-in')
        expect(navigated).toEqual([path])
        expect(loadsAgainAfterSignIn(path)).toBe(true)
    })

    it('goes on to the page that sent the person to sign in', async () => {
        native.signIn.mockResolvedValue(grant())
        await signInToEtherPK('/graph/folder/garden', on('/graphs?tab=sync'))
        expect(navigated).toEqual(['/graph/folder/garden'])
    })

    it.each(['/graph/folder/garden/d/Beans', '/folder/garden', '/demo', '/graphsomething', '/'])('leaves %s as it is', (path) => {
        expect(loadsAgainAfterSignIn(path)).toBe(false)
    })

    it('never goes to an address outside the app', async () => {
        native.signIn.mockResolvedValue(grant())
        for (const path of ['https://garden.example/graphs', '//garden.example', 'javascript:alert(1)']) await signInToEtherPK(path, on('/graphs'))
        expect(navigated).toEqual([])
    })

    it('says to finish in the browser while it waits, and takes that away after', async () => {
        let finish: (value: unknown) => void = () => {}
        native.signIn.mockReturnValue(new Promise((resolve) => { finish = resolve }))
        const signingIn = signInToEtherPK('/demo', on('/demo'))
        await vi.waitFor(() => expect(getNotices()).toEqual([expect.objectContaining({ id: 'managed-sign-in', tone: 'info', dismissal: 'manual' })]))
        finish(grant())
        await signingIn
        expect(getNotices()).toEqual([])
    })

    it('says nothing when the person gives up', async () => {
        native.signIn.mockRejectedValue(failure('AbortError'))
        await expect(signInToEtherPK('/graphs', on('/graphs'))).resolves.toBe('not-signed-in')
        expect(getNotices()).toEqual([])
        expect(navigated).toEqual([])
    })

    it.each([
        ['NetworkError', 'could not be reached'],
        ['OperationError', 'was not completed'],
        ['NotSupportedError', 'does not sign in'],
    ])('tells the person in words when it fails with %s', async (name, words) => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        native.signIn.mockRejectedValue(failure(name))
        await expect(signInToEtherPK('/graphs', on('/graphs'))).resolves.toBe('not-signed-in')
        const [notice] = getNotices()
        expect(notice).toMatchObject({ tone: 'error' })
        expect(notice.text).toContain(words)
        expect(notice.text).not.toContain(name)
        expect(notice.text).not.toContain('for the log')
        expect(console.error).toHaveBeenCalled()
    })

    it('keeps the notice of a second sign-in when the first, which it replaced, ends', async () => {
        let end: (error: unknown) => void = () => {}
        native.signIn.mockReturnValueOnce(new Promise((_, reject) => { end = reject })).mockReturnValueOnce(new Promise(() => {}))
        const first = signInToEtherPK('/demo', on('/demo'))
        void signInToEtherPK('/demo', on('/demo'))
        end(failure('AbortError'))
        await expect(first).resolves.toBe('not-signed-in')
        expect(getNotices()).toHaveLength(1)
    })

    it('takes a sign-in link over', async () => {
        native.signIn.mockResolvedValue(grant())
        const event = { preventDefault: vi.fn() }
        managedSignInOnClick('/graph/sync/018f47a0', on('/graph/sync/018f47a0'))(event as unknown as MouseEvent)
        expect(event.preventDefault).toHaveBeenCalled()
        await vi.waitFor(() => expect(navigated).toEqual(['/graph/sync/018f47a0']))
    })

    it('is refused in words by a shell with no sign-in', async () => {
        native.available = false
        await expect(signInToEtherPK('/graphs', on('/graphs'))).resolves.toBe('not-signed-in')
        expect(native.signIn).not.toHaveBeenCalled()
        expect(getNotices()[0].text).toContain('does not sign in')
    })
})

describe('signing out of an installed app', () => {
    it('answers true when the shell has forgotten the sign-in', async () => {
        await expect(signOutOfInstalledApp()).resolves.toBe(true)
        expect(getNotices()).toEqual([])
    })

    it('says the sign-out did not finish, and answers false, when the shell could not forget it', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        native.signIn.mockResolvedValue(grant())
        await signInToEtherPK('/demo', on('/demo'))
        native.signOut.mockRejectedValue(failure('OperationError'))
        await expect(signOutOfInstalledApp()).resolves.toBe(false)
        // The token this page held goes all the same: the shell hands out a new one while it still signs in.
        await expect(managedBearerToken()).rejects.toMatchObject({ status: 401 })
        expect(console.error).toHaveBeenCalled()
        expect(getNotices().map((one) => one.text)).toEqual([
            'EtherPK could not sign you out in this app, and you may still be signed in when it opens again. Try signing out again.',
        ])
    })
})
