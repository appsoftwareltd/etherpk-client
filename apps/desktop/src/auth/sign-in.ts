/**
 * The app's one sign-in. The refresh token stays here and the page is given access tokens.
 *
 * The refresh token is single use, and one used again later ends the account's sign-in on every
 * device. So everything that reads or changes it takes its turn, and a new one is on the disk before
 * the access token that came with it is answered.
 */
import { setTimeout as delay } from 'node:timers/promises'
import type { AccessTokenGrant } from '@appsoftwareltd/etherpk-native-bridge'
import { NativeFailure } from '../failure.ts'
import { Locks } from '../fs/locks.ts'
import { listenForCallback, type Loopback } from './loopback.ts'
import { AnswerLost, type Attempt, authorizeUrl, type Callback, type Issuer, IssuerUnavailable, newAttempt, NoTokens, readCallback, SignInOver, type TokenSet } from './oauth.ts'
import type { TokenStore } from './token-store.ts'

/** A person may register, find a second factor or reset a password on the way. */
const ATTEMPT_MS = 15 * 60 * 1000
const REFRESH_WHEN_LEFT_MS = 60_000
/** The issuer repeats its answer to a refresh token used again within this long. */
export const REPEAT_WINDOW_MS = 30_000
export const REPEAT_AFTER_MS = 2_000
/**
 * How long one refresh may take. Short enough that a first attempt that hears nothing, the wait and
 * the one repeat all end well inside the issuer's window, with room for the two clocks to differ.
 */
export const REFRESH_ATTEMPT_MS = 10_000
/** The part of the window a repeat must leave unused, since the issuer's clock started first. */
const WINDOW_MARGIN_MS = 4_000

export interface SignInParts {
    issuer: Issuer | null
    store: TokenStore
    openBrowser(url: string): Promise<void>
    /** The browser came back. Bring the app in front of it. */
    returned(): void
    /** Told once when a sign-in will not outlast the app. */
    notLasting(): void
    /** Told once when a sign-in could not be saved, so it ends with the app. */
    notSaved(): void
    /** Told when the sign-in was ended here because a refresh token may be spent (see `refreshOnceMore`). */
    endedHere(): void
    log(message: string, error: unknown): void
    now?: () => number
    wait?: (ms: number) => Promise<unknown>
}

interface Running { attempt: Attempt; loopback: Loopback; end(result: Callback): void }

/** A refresh token that may have been spent with no answer heard, and cannot be asked about again in time. */
class MaybeSpent extends Error {}

export class AppSignIn {
    private readonly turns = new Locks()
    private readonly now: () => number
    private refreshToken: string | null = null
    private grant: AccessTokenGrant | null = null
    private loaded: Promise<void> | null = null
    private running: Running | null = null
    private refreshing: Promise<AccessTokenGrant | null> | null = null
    private toldNotSaved = false

    constructor(private readonly parts: SignInParts) {
        this.now = parts.now ?? Date.now
    }

    private inTurn<T>(task: () => Promise<T>): Promise<T> {
        return this.turns.run('token', task)
    }

    private load(): Promise<void> {
        this.loaded ??= this.parts.store.load().then((token) => { this.refreshToken = token })
        return this.loaded
    }

    private issuer(): Issuer {
        if (!this.parts.issuer) throw new NativeFailure('NotSupportedError', 'This build has no sign-in.')
        return this.parts.issuer
    }

    async signedIn(): Promise<boolean> {
        if (!this.parts.issuer) return false
        await this.load()
        return this.refreshToken !== null
    }

    async signIn(): Promise<AccessTokenGrant> {
        const issuer = this.issuer()
        this.cancel()
        const endpoints = await this.asFailure(() => issuer.discover())
        const { attempt, result } = await this.start()
        try {
            await this.parts.openBrowser(authorizeUrl(issuer.config, endpoints, attempt))
        } catch (error) {
            this.cancel()
            void result.catch(() => {})
            throw error
        }
        const callback = await result
        if (callback.kind === 'failed') throw new NativeFailure('OperationError', `The sign-in failed: ${callback.error.slice(0, 100)}`)
        if (callback.kind !== 'code') throw new NativeFailure('AbortError', 'The person did not sign in.')
        return this.asFailure(() => this.inTurn(async () => {
            const grant = await this.keep(await issuer.exchange(callback.code, attempt))
            if (!this.parts.store.lasting) this.parts.notLasting()
            return grant
        }))
    }

    /** End a sign-in that is waiting for the browser. */
    cancel(): void {
        this.running?.end({ kind: 'denied' })
    }

    private async start(): Promise<{ attempt: Attempt; result: Promise<Callback> }> {
        const { promise: result, resolve } = Promise.withResolvers<Callback>()
        const issuer = this.issuer()
        let running: Running | null = null
        const loopback = await listenForCallback((query) => {
            const callback = running ? readCallback(query, running.attempt, issuer.config.issuer) : ({ kind: 'other' } as const)
            if (callback.kind === 'other') return { taken: false, signedIn: false }
            running!.end(callback)
            this.parts.returned()
            return { taken: true, signedIn: callback.kind === 'code' }
        })
        const timer = setTimeout(() => running?.end({ kind: 'denied' }), ATTEMPT_MS)
        timer.unref()
        running = {
            attempt: newAttempt(loopback.redirectUri), loopback,
            end: (callback) => {
                clearTimeout(timer)
                loopback.close()
                if (this.running === running) this.running = null
                resolve(callback)
            },
        }
        // Two at once would leave one of them listening for ever.
        this.cancel()
        this.running = running
        return { attempt: running.attempt, result }
    }

    /** Store first, answer second. */
    private async keep(tokens: TokenSet): Promise<AccessTokenGrant> {
        this.refreshToken = tokens.refreshToken
        this.grant = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt }
        this.loaded = Promise.resolve()
        try {
            await this.parts.store.save(tokens.refreshToken)
        } catch (error) {
            // Still signed in until the app ends, and the person knows it will not outlast it.
            this.parts.log('The sign-in could not be kept.', error)
            if (!this.toldNotSaved) this.parts.notSaved()
            this.toldNotSaved = true
        }
        return this.grant
    }

    private async asFailure<T>(task: () => Promise<T>): Promise<T> {
        try {
            return await task()
        } catch (error) {
            if (error instanceof IssuerUnavailable) throw new NativeFailure('NetworkError', error.message)
            throw error
        }
    }

    async accessToken(forceRefresh: boolean): Promise<AccessTokenGrant | null> {
        if (!(await this.signedIn())) return null
        if (!forceRefresh && this.grant && this.grant.expiresAt - this.now() > REFRESH_WHEN_LEFT_MS) return this.grant
        // Everyone who asks while a refresh runs shares it.
        this.refreshing ??= this.inTurn(() => this.refresh()).finally(() => { this.refreshing = null })
        return this.asFailure(() => this.refreshing!)
    }

    private async refresh(): Promise<AccessTokenGrant | null> {
        if (this.refreshToken === null) return null
        try {
            return await this.keep(await this.refreshOnceMore(this.refreshToken))
        } catch (error) {
            if (error instanceof SignInOver) {
                this.parts.log('The sign-in is over.', error)
                await this.forget()
                return null
            }
            if (!(error instanceof MaybeSpent)) throw error
            // Sent again after the issuer's window, the token would end the account's sign-in on every
            // device. Only this one signs in again.
            this.parts.log('The sign-in was ended here: its refresh token may be spent.', error)
            await this.forget()
            this.parts.endedHere()
            return null
        }
    }

    /**
     * A refresh, and one repeat of it when the first may have reached the issuer and no answer came.
     * The issuer repeats its answer to a spent token for 30 seconds, so the repeat goes while it still
     * does. After that the token is never sent again: {@link MaybeSpent}.
     *
     * One that never left the computer is a plain `IssuerUnavailable`, and the token is kept. An answer
     * with no tokens in it means the issuer took the token, so that one is spent too.
     */
    private async refreshOnceMore(refreshToken: string): Promise<TokenSet> {
        const started = this.now()
        try {
            return await this.issuer().refresh(refreshToken, REFRESH_ATTEMPT_MS)
        } catch (error) {
            if (error instanceof NoTokens) throw new MaybeSpent(error.message, { cause: error })
            if (!(error instanceof AnswerLost)) throw error
            const left = REPEAT_WINDOW_MS - WINDOW_MARGIN_MS - (this.now() - started) - REPEAT_AFTER_MS
            if (left < REPEAT_AFTER_MS) throw new MaybeSpent('No answer came while the issuer repeats it.', { cause: error })
            await (this.parts.wait ?? delay)(REPEAT_AFTER_MS)
            try {
                return await this.issuer().refresh(refreshToken, Math.min(REFRESH_ATTEMPT_MS, left))
            } catch (again) {
                if (again instanceof SignInOver) throw again
                throw new MaybeSpent('The repeat had no answer either.', { cause: again })
            }
        }
    }

    private async forget(): Promise<void> {
        this.refreshToken = null
        this.grant = null
        await this.parts.store.clear()
    }

    async signOut(): Promise<void> {
        this.cancel()
        if (!(await this.signedIn())) return
        // In turn, so a refresh on its way has ended and the token revoked is the last one issued.
        // Revoking one already spent would end the account's other devices.
        const last = await this.inTurn(async () => {
            const token = this.refreshToken
            await this.forget()
            return token
        })
        if (last === null) return
        await this.issuer().revoke(last).catch((error: unknown) => this.parts.log('The sign-in was forgotten here and could not be revoked.', error))
    }
}
