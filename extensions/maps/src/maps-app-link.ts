/**
 * The address that opens a place in the person's own maps app, for directions and the like: the
 * app does the routing, so EtherPK needs no routing service for "how do I get there" (ADR 0119).
 *
 * Apple devices get an Apple Maps address and every other device a Google Maps one: each opens
 * the installed app on a phone and the website elsewhere. A `geo:` link is not used, because only
 * Android opens one reliably.
 */
import type { MapPoint } from '$lib/document/map-text'

/** Whether the device is an iPhone, iPad or Mac, from what the browser says it runs on. */
export function isAppleDevice(userAgent: string, platform = ''): boolean {
    return /iPhone|iPad|iPod|Macintosh/.test(userAgent) || /^(iPhone|iPad|iPod|Mac)/.test(platform)
}

/** The address that shows `point` in the device's maps app, named when it has a name. */
export function mapsAppUrl(point: MapPoint, name: string, apple: boolean): string {
    const at = `${point.lat},${point.lon}`
    if (apple) {
        const url = new URL('https://maps.apple.com/')
        url.searchParams.set('ll', at)
        url.searchParams.set('q', name.trim() === '' ? at : name.trim())
        return url.toString()
    }
    const url = new URL('https://www.google.com/maps/search/')
    url.searchParams.set('api', '1')
    url.searchParams.set('query', at)
    return url.toString()
}
