/**
 * A 404 for a request whose path starts with `//`, or null to let the app answer it. Such a path
 * reads as another host once a page puts it back into a link or a form action
 * (`//example.com/...`), and SvelteKit 2's enhanced forms build the action's address from the
 * page's path. No route of the apps is meant to answer one, so each app's `handle` refuses it
 * before routing.
 */
export function refusedRequestPath(url: URL): Response | null {
    return url.pathname.startsWith('//') ? new Response('Not found', { status: 404 }) : null
}
