/** What the app was started with: the files, folders and links among its arguments. */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ETHERPK_LINK_SCHEME } from '@appsoftwareltd/etherpk-native-bridge'

export type Started = { kind: 'link'; url: string } | { kind: 'path'; path: string }

const LONGEST = 8_192

function startedWith(argument: string, cwd: string): Started | null {
    if (argument === '' || argument.length > LONGEST || argument.startsWith('-')) return null
    if (argument.toLowerCase().startsWith(`${ETHERPK_LINK_SCHEME}:`)) return URL.canParse(argument) ? { kind: 'link', url: argument } : null
    if (argument.toLowerCase().startsWith('file:')) {
        try {
            return { kind: 'path', path: fileURLToPath(argument) }
        } catch {
            return null
        }
    }
    // `C:\Notes` parses as an address with the scheme "c", so a path is recognised first.
    if (!isAbsolute(argument) && /^[a-z][a-z0-9+.-]+:/i.test(argument)) return null
    return { kind: 'path', path: resolve(cwd, argument) }
}

/**
 * `argv` with the executable, and in a development run the app's folder, already taken off. A link is
 * one argument and the only one, since a browser hands over an address that anyone can write: an
 * address with a space in it must not become a link and a path.
 */
export function startedWithAll(argv: readonly string[], cwd: string): Started[] {
    const started = argv.map((argument) => startedWith(argument, cwd)).filter((one) => one !== null)
    const link = started.find((one) => one.kind === 'link')
    return link ? [link] : started
}

/**
 * The arguments a person or the system gave: those after the executable, or in a development run after
 * the app's folder, which is an argument of Electron's own.
 */
export function ownArguments(argv: readonly string[], developmentApp: string | null): string[] {
    if (developmentApp === null) return argv.slice(1)
    const at = argv.findIndex((argument, index) => index > 0 && !argument.startsWith('-') && resolve(argument) === resolve(developmentApp))
    return argv.slice(at + 1)
}
