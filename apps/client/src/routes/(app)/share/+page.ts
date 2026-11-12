import type { PageLoad } from './$types'

/**
 * The [[Share Target]]'s action URL: the manifest's `share_target.params` name the share
 * sheet's fields `title`, `text` and `url`. The share is a form post (ADR 0186), and whoever
 * receives it (the service worker, or `+server.ts`) redirects here with the fields on the query
 * and `files` naming where its files are kept. Read here so the page composes from typed data;
 * nothing else is fetched.
 */
export const load: PageLoad = ({ url }) => ({
    title: url.searchParams.get('title'),
    text: url.searchParams.get('text'),
    url: url.searchParams.get('url'),
    /** Where the share's files are kept on this device (`shared-files.ts`), or that they were dropped. */
    files: url.searchParams.get('files'),
})
