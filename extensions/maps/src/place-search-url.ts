/**
 * A Photon server this deployment's Client asks directly for place search (ADR 0119), in place of
 * a Sync Server, so searching by name needs no account: `PUBLIC_PLACE_SEARCH_URL`, the server's
 * search API such as `https://photon.example.com/api`. Unset or empty, searches go through the
 * graph's Sync Server.
 */
import { env } from '$env/dynamic/public'

export function placeSearchPhotonUrl(value: string | undefined = env.PUBLIC_PLACE_SEARCH_URL): string | null {
    const url = value?.trim()
    if (!url) return null
    try {
        return new URL(url).toString()
    } catch {
        return null
    }
}
