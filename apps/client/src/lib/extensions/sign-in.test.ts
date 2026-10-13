import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createExtensionSignIn, readReturnParameters, SIGN_IN_CHANNEL, SIGN_IN_PATH, type SignInChannel } from './sign-in'

/** A BroadcastChannel stand-in shared by every "tab" a test makes, as one origin's channel is. */
function channels() {
    const open = new Set<SignInChannel>()
    const make = (name: string): SignInChannel => {
        expect(name).toBe(SIGN_IN_CHANNEL)
        const channel: SignInChannel = {
            onmessage: null,
            postMessage(data: unknown) {
                for (const other of open) if (other !== channel) other.onmessage?.({ data } as MessageEvent)
            },
            close: () => void open.delete(channel),
        }
        open.add(channel)
        return channel
    }
    return { make, open }
}

function setUp() {
    const bus = channels()
    const popup = { close: vi.fn(), closed: false }
    const openWindow = vi.fn((): typeof popup | null => popup)
    const signIn = createExtensionSignIn({ origin: 'https://client.example', openWindow, channel: bus.make })
    /** The return page, in the popup, passing on what the service sent back. */
    const returnPage = (parameters: Record<string, string>) => bus.make(SIGN_IN_CHANNEL).postMessage({ parameters })
    return { signIn, openWindow, popup, returnPage, bus }
}

describe('signing in from an extension', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('names one return address on the Client', () => {
        expect(setUp().signIn.redirectUri).toBe(`https://client.example${SIGN_IN_PATH}`)
        expect(SIGN_IN_PATH).toBe('/extension-sign-in')
    })

    it('opens the sign-in in a popup and answers with what the return page passed on, closing the popup', async () => {
        const { signIn, openWindow, popup, returnPage, bus } = setUp()
        const answer = signIn.authorize('https://accounts.example/auth?client_id=garden&state=s1')
        expect(openWindow).toHaveBeenCalledWith('https://accounts.example/auth?client_id=garden&state=s1')
        returnPage({ code: 'c1', state: 's1' })
        await expect(answer).resolves.toEqual({ code: 'c1', state: 's1' })
        expect(popup.close).toHaveBeenCalled()
        // The return page's channel is the only one still open: the sign-in closed its own.
        expect(bus.open.size).toBe(1)
    })

    it('answers each sign-in only with a return carrying its own state', async () => {
        const { signIn, returnPage } = setUp()
        const first = signIn.authorize('https://accounts.example/auth?state=s1')
        const second = signIn.authorize('https://accounts.example/auth?state=s2')
        const heard: string[] = []
        void first.then((parameters) => heard.push(`first ${parameters.code}`))
        void second.then((parameters) => heard.push(`second ${parameters.code}`))
        returnPage({ code: 'c2', state: 's2' })
        returnPage({ code: 'stray', state: 'other' })
        returnPage({ code: 'c1', state: 's1' })
        await Promise.all([first, second])
        expect(heard).toEqual(['second c2', 'first c1'])
    })

    it('passes on a refusal as the service said it', async () => {
        const { signIn, returnPage } = setUp()
        const answer = signIn.authorize('https://accounts.example/auth?state=s1')
        returnPage({ error: 'access_denied', state: 's1' })
        await expect(answer).resolves.toEqual({ error: 'access_denied', state: 's1' })
    })

    it('refuses an address without a state, which no return could be matched to', async () => {
        const { signIn, openWindow } = setUp()
        await expect(signIn.authorize('https://accounts.example/auth?client_id=garden')).rejects.toThrow('The sign-in address must carry a state parameter.')
        await expect(signIn.authorize('not an address')).rejects.toThrow('The sign-in address must carry a state parameter.')
        expect(openWindow).not.toHaveBeenCalled()
    })

    it('refuses an address that is not https, other than on this device', async () => {
        const { signIn, openWindow } = setUp()
        await expect(signIn.authorize('http://accounts.example/auth?state=s1')).rejects.toThrow('The sign-in address must be an https address.')
        await expect(signIn.authorize('javascript:alert(1)//?state=s1')).rejects.toThrow('The sign-in address must be an https address.')
        expect(openWindow).not.toHaveBeenCalled()
        // Opened at once, inside the click that asked for it, which is what lets a browser allow it.
        void signIn.authorize('http://localhost:5299/auth?state=s1').catch(() => {})
        expect(openWindow).toHaveBeenCalledWith('http://localhost:5299/auth?state=s1')
    })

    it('says so when the browser blocks the popup', async () => {
        const { signIn, openWindow } = setUp()
        openWindow.mockReturnValueOnce(null)
        await expect(signIn.authorize('https://accounts.example/auth?state=s1')).rejects.toThrow(
            'The browser blocked the sign-in window. Allow pop-ups for this site, then try again.',
        )
    })

    it('gives up when the extension aborts, closing the popup', async () => {
        const { signIn, popup, returnPage } = setUp()
        const controller = new AbortController()
        const answer = signIn.authorize('https://accounts.example/auth?state=s1', { signal: controller.signal })
        controller.abort()
        await expect(answer).rejects.toThrow('The sign-in was cancelled.')
        expect(popup.close).toHaveBeenCalled()
        // A return after that changes nothing.
        returnPage({ code: 'late', state: 's1' })
    })

    it('gives up after ten minutes', async () => {
        const { signIn } = setUp()
        const answer = signIn.authorize('https://accounts.example/auth?state=s1')
        const failed = expect(answer).rejects.toThrow('The sign-in took too long. Try again.')
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        await failed
    })
})

describe('the return page', () => {
    it('reads the parameters from the query and the fragment, the fragment winning', () => {
        expect(readReturnParameters(new URL('https://client.example/extension-sign-in?code=c1&state=s1'))).toEqual({ code: 'c1', state: 's1' })
        expect(readReturnParameters(new URL('https://client.example/extension-sign-in#access_token=t1&state=s1'))).toEqual({ access_token: 't1', state: 's1' })
        expect(readReturnParameters(new URL('https://client.example/extension-sign-in?state=a#state=b'))).toEqual({ state: 'b' })
        expect(readReturnParameters(new URL('https://client.example/extension-sign-in'))).toEqual({})
    })
})
