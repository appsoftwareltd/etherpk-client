import type { PageLoad } from './$types'

/**
 * The [[Share Target]]'s action URL: the manifest's `share_target.params` name the share
 * sheet's fields `title`, `text` and `url`, and the GET flavour puts them on the query. Read
 * here so the page composes from typed data; nothing else is fetched.
 */
export const load: PageLoad = ({ url }) => ({
    title: url.searchParams.get('title'),
    text: url.searchParams.get('text'),
    url: url.searchParams.get('url'),
})
