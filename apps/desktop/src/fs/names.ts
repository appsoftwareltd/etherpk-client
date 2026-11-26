/**
 * Which relative paths a shell may act on, and how a name on disk is spelled for the page.
 *
 * `checkedRelativePath` (the interface's own rule) refuses what leaves a folder on every platform.
 * Windows adds names that are not files there at all: a colon names a drive or an alternate stream,
 * `CON` and its like are devices in every directory, and a trailing dot or space is dropped, so two
 * spellings would be one file.
 */
import { checkedRelativePath } from '@appsoftwareltd/etherpk-native-bridge'
import { NativeFailure } from '../failure.ts'

/** Ends the name of every file the app writes on the way to another. The Client never lists one. */
export const TEMP_SUFFIX = '.crswap'
export const TEMP_PREFIX = '.etherpk-'

export function isTemporaryName(name: string): boolean {
    return name.toLowerCase().endsWith(TEMP_SUFFIX)
}

const WINDOWS_FORBIDDEN = /[<>:"|?*]/
/** With any extension: `nul.txt` is the same device as `nul`. The superscripts are digits to Windows. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

export function isWindowsSafeName(name: string): boolean {
    return !WINDOWS_FORBIDDEN.test(name) && !/[. ]$/.test(name) && !WINDOWS_DEVICE.test(name.replace(/\s+(?=\.|$)/g, ''))
}

/** The segments of a path the page gave, composed, or a refusal. */
export function segmentsOf(path: unknown, platform: NodeJS.Platform): string[] {
    const segments = checkedRelativePath(path)
    if (segments === null) throw new NativeFailure('SecurityError', 'The path leads out of the folder.')
    if (platform === 'win32' && !segments.every(isWindowsSafeName)) {
        throw new NativeFailure('SecurityError', 'Windows does not allow that file name.')
    }
    return segments.map((segment) => segment.normalize('NFC'))
}

/**
 * A name on disk as the page may be told it, or null for one it could not ask for again: a name with a
 * backslash (legal on Linux, a separator elsewhere) or one that is not valid text.
 */
export function shownName(name: string): string | null {
    const composed = name.normalize('NFC')
    if (composed.includes('�') || isTemporaryName(composed)) return null
    const segments = checkedRelativePath(composed)
    return segments?.length === 1 ? composed : null
}
