/** What a page of the app may do with addresses and permissions. Everything not named here is refused. */
import { DESKTOP_APP_ORIGIN } from '@appsoftwareltd/etherpk-native-bridge'
import { openableUrl } from '../port/external.ts'

export function isAppUrl(url: string): boolean {
    if (!URL.canParse(url)) return false
    const { protocol, host, username, password } = new URL(url)
    return `${protocol}//${host}` === DESKTOP_APP_ORIGIN && username === '' && password === ''
}

/** Paths of the app's origin that are content and not the Client: never a window of their own. */
const CONTENT_PATHS = /^\/__etherpk-/

export type Opened = { kind: 'app'; url: string } | { kind: 'external'; url: string } | { kind: 'refused' }

/** What opening an address in a new window does. */
export function openedWindow(url: string): Opened {
    if (isAppUrl(url)) return CONTENT_PATHS.test(new URL(url).pathname) ? { kind: 'refused' } : { kind: 'app', url }
    const external = openableUrl(url)
    return external === null ? { kind: 'refused' } : { kind: 'external', url: external }
}

export interface PermissionRequest { permission: string; isMainFrame: boolean; origin: string }

/** The app's own page only. */
const OF_THE_APP = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'persistent-storage', 'screen-wake-lock', 'fileSystem'])
/** A video in a document may fill the screen. */
const OF_A_PLAYER = new Set(['fullscreen'])
const PLAYER_ORIGINS = new Set(['https://www.youtube-nocookie.com', 'https://player.vimeo.com'])

export function isAllowed({ permission, isMainFrame, origin }: PermissionRequest): boolean {
    const from = origin.replace(/\/$/, '')
    if (from === DESKTOP_APP_ORIGIN) return isMainFrame && OF_THE_APP.has(permission)
    return PLAYER_ORIGINS.has(from) && OF_A_PLAYER.has(permission)
}
