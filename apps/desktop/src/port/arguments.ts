/**
 * What each method may be sent. The page is the sender, and an extension runs in the page, so nothing
 * it sends is taken to be what the interface says until it has been checked here.
 */
import type { NativeArgs, NativeMethod } from '@appsoftwareltd/etherpk-native-bridge'
import { NativeFailure } from '../failure.ts'

type Check = (value: unknown) => boolean
type Shape = Record<string, Check>

/** Nothing the page names or addresses is longer. Bytes have no limit but the disk's. */
const LONGEST_TEXT = 8_192
const MOST_ITEMS = 100_000

const text: Check = (value) => typeof value === 'string' && value.length <= LONGEST_TEXT
const flag: Check = (value) => typeof value === 'boolean'
const whole: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0
const bytes: Check = (value) => value instanceof Uint8Array
const texts: Check = (value) => Array.isArray(value) && value.length <= MOST_ITEMS && value.every(text)
const optional = (check: Check): Check => (value) => value === undefined || check(value)
const stamp: Check = (value) => isRecord(value) && typeof value.lastModified === 'number' && whole(value.size)
const stampOrAbsent: Check = (value) => value === 'absent' || stamp(value)
const oneOf = (...values: unknown[]): Check => (value) => values.includes(value)

const inFolder: Shape = { folder: text, path: text }

const SHAPES: Record<NativeMethod, Shape> = {
    'shell.openExternal': { url: text },
    'shell.showInFileManager': inFolder,
    'shell.print': {},
    'shell.setTheme': { scheme: oneOf('light', 'dark') },
    'shell.closeAnswer': { allow: flag },
    'clipboard.readText': {},
    'folders.pick': { title: optional(text) },
    'folders.get': { folder: text },
    'folders.forget': { folder: text },
    'folders.relation': { a: text, b: text },
    'folders.child': inFolder,
    'fs.list': { ...inFolder, stamps: flag },
    'fs.stat': inFolder,
    'fs.canonicalPath': inFolder,
    'fs.read': inFolder,
    'fs.readMany': { folder: text, paths: texts },
    'fs.write': { ...inFolder, bytes, createDirectories: optional(flag), ifStamp: optional(stampOrAbsent) },
    'fs.createDirectory': inFolder,
    'fs.remove': inFolder,
    'fs.move': { folder: text, from: text, to: text },
    'fs.walk': { ...inFolder, skip: texts, limit: whole },
    'fs.watch': { folder: text },
    'fs.unwatch': { watch: text },
    'files.read': { file: text },
    'files.readPart': { file: text, offset: whole, length: whole },
    'files.write': { file: text, bytes, ifStamp: optional(stamp) },
    'files.release': { file: text },
    'save.open': { name: text, type: text },
    'save.write': { save: text, bytes },
    'save.commit': { save: text },
    'save.abort': { save: text },
    'launches.take': {},
    'auth.signIn': {},
    'auth.accessToken': { forceRefresh: optional(flag) },
    'auth.signedIn': {},
    'auth.signOut': {},
    'updates.status': {},
    'updates.check': {},
    'updates.install': {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNativeMethod(method: unknown): method is NativeMethod {
    return typeof method === 'string' && Object.hasOwn(SHAPES, method)
}

/** The arguments of a method, only the fields it has, or a refusal. */
export function checkedArguments<M extends NativeMethod>(method: M, args: unknown): NativeArgs<M> {
    const shape = SHAPES[method]
    if (!isRecord(args)) throw new NativeFailure('OperationError', `${method} was sent something that is not its arguments.`)
    const checked: Record<string, unknown> = {}
    for (const [field, check] of Object.entries(shape)) {
        const value = Object.hasOwn(args, field) ? args[field] : undefined
        if (!check(value)) throw new NativeFailure('OperationError', `${method} was sent a wrong "${field}".`)
        if (value !== undefined) checked[field] = value
    }
    return checked as NativeArgs<M>
}
