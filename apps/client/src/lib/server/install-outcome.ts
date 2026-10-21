/**
 * The answer to `GET /api/install?outcome=…`, which the Client sends when the browser's install
 * dialog is accepted or dismissed and when the app is installed (`app-install.ts`). The server
 * keeps nothing: the request log's line for the request is the count, read by the install panels
 * on the operator's dashboard. No cookie, account or device identifier is involved.
 */

const OUTCOMES = new Set(['accepted', 'dismissed', 'installed'])

export function installOutcomeResponse(url: URL): Response {
    const known = OUTCOMES.has(url.searchParams.get('outcome') ?? '')
    return new Response(null, { status: known ? 204 : 400, headers: { 'cache-control': 'no-store' } })
}
