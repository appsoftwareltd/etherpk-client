/**
 * What servers know about the installed apps (the desktop and Android apps). These are fixed in the
 * apps a person has already installed, so they are constants here and not settings: a server that
 * could change one would cut those apps off.
 */

/**
 * The origin an installed app presents to servers, on every platform. The address is answered inside
 * the app. `packages/native-bridge` states it too, for the shells, and
 * `scripts/repository-rules.test.mjs` fails when the two differ.
 */
export const INSTALLED_APP_ORIGIN = 'https://installed.app.etherpk.com'

/**
 * The OAuth client every installed app signs in to EtherPK as. It is not the hosted Client's, because
 * a refresh token used twice ends every sign-in an account holds for that client: a desktop app that
 * lost a reply would otherwise sign the browsers out.
 */
export const INSTALLED_APP_CLIENT_ID = 'etherpk-installed'

/**
 * Where a sign-in in the system browser returns to. The desktop app listens on the loopback address
 * at a port it is given, and the port is not part of the match (RFC 8252, section 7.3). Android
 * returns by the app's own scheme, which is its package name (section 7.1).
 */
export const INSTALLED_APP_REDIRECT_URIS = [
    'http://127.0.0.1/callback',
    'com.etherpk.app:/auth/callback',
] as const
