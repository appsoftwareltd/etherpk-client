/**
 * Signing in to another service from an extension (ADR 0140), such as a calendar, with OAuth 2.0 in
 * a popup. Extensions cannot add pages to the Client, so the Client has one page every sign-in
 * returns to, `redirectUri`, which passes what the service sent back to the window that opened the
 * popup. The extension builds the sign-in request itself (its client id, scopes, PKCE and `state`),
 * so nothing in the Client is tied to one service.
 */

/**
 * How long a sign-in may take, and how to give up on it.
 *
 * @public
 */
export interface AuthorizeOptions {
    /** Aborting it gives up on the sign-in: `authorize` rejects, and its popup is closed. */
    signal?: AbortSignal
}

/**
 * Signing in to another service.
 *
 * @public
 */
export interface ExtensionAuth {
    /**
     * The address a sign-in returns to: this Client's origin followed by `/extension-sign-in`. It is
     * the same for every extension and every graph, so the person registers it with the service
     * once.
     */
    readonly redirectUri: string
    /**
     * Open `url`, the service's sign-in address, in a popup, and wait for the service to send the
     * popup back to `redirectUri`. Resolves with the parameters it came back with, from its query
     * and its fragment, such as `code` and `state`, or `error` when the person refused. The popup is
     * closed by then.
     *
     * `url` must carry a `state` parameter: only a return with the same `state` answers this call,
     * so two sign-ins at once, in this tab or another, never take each other's answer. Call it from
     * a click or a key press, because a browser blocks a popup opened at any other time. Rejects when
     * the popup is blocked, when `options.signal` aborts, or after ten minutes. A person who closes
     * the popup without finishing is not reported, since the Client cannot always tell, so the
     * extension offers a way to give up (`options.signal`).
     */
    authorize(url: string, options?: AuthorizeOptions): Promise<Record<string, string>>
}
