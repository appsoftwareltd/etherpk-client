/**
 * Connecting OpenRouter without pasting a key (ADR 0147): OpenRouter's PKCE sign-in, through the
 * Client's one sign-in return page (`context.auth`, ADR 0140). The person signs in to OpenRouter
 * in a popup, and the code it returns is traded, from the browser, for a key that belongs to the
 * person, which they can limit and revoke in OpenRouter's settings.
 *
 * OpenRouter returns to the callback address as it was given and adds only `code`, so the `state`
 * the Client's sign-in waits for is put in the callback address as well as the sign-in address.
 */
import type { ExtensionAuth } from '@appsoftwareltd/etherpk-extension-api'

import { ProviderError } from './models'

/** Bytes as base64url, without padding, as PKCE writes a verifier and a challenge. */
function base64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

function randomText(size: number): string {
    return base64url(crypto.getRandomValues(new Uint8Array(size)))
}

/** Sign in to OpenRouter and answer the key it issues. Call it from a click: it opens a popup. */
export async function connectOpenRouter(auth: Pick<ExtensionAuth, 'redirectUri' | 'authorize'>, options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<string> {
    const verifier = randomText(32)
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const state = randomText(16)
    const callback = new URL(auth.redirectUri)
    callback.searchParams.set('state', state)
    const url = new URL('https://openrouter.ai/auth')
    url.searchParams.set('callback_url', callback.href)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)

    const answer = await auth.authorize(url.href, { signal: options.signal })
    if (!answer.code) throw new ProviderError('OpenRouter did not connect. Try again, or paste a key from OpenRouter instead.', 'key')

    let response: Response
    try {
        response = await (options.fetchImpl ?? fetch)('https://openrouter.ai/api/v1/auth/keys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: answer.code, code_verifier: verifier, code_challenge_method: 'S256' }),
            signal: options.signal,
        })
    } catch (error) {
        if (options.signal?.aborted) throw error
        throw new ProviderError('Could not reach OpenRouter to finish connecting. Check your internet connection, then try again.', 'network')
    }
    if (!response.ok) throw new ProviderError(`OpenRouter refused to issue a key (error ${response.status}). Try again, or paste a key from OpenRouter instead.`, 'key')
    const body = (await response.json().catch(() => null)) as { key?: unknown } | null
    if (typeof body?.key !== 'string' || body.key === '') throw new ProviderError('OpenRouter sent no key. Try again, or paste a key from OpenRouter instead.', 'other')
    return body.key
}
