/**
 * Replacing a file whole. The bytes go to a temporary file beside it, are flushed to the disk, and
 * take the file's place in one rename, so a reader, or a computer that loses power, has the old bytes
 * or the new ones and never a mixture.
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { FileStamp } from '@appsoftwareltd/etherpk-native-bridge'
import { codeOf, isMissing, NativeFailure } from '../failure.ts'
import { TEMP_PREFIX, TEMP_SUFFIX } from './names.ts'
import { stampOf } from './stamp.ts'

/** How long a file another program holds is waited for. Antivirus and sync clients let go in well under this. */
export const RENAME_WAITS_MS = [10, 20, 40, 80, 160, 320, 640, 730]

/** The step that can meet a file held by another program, so that tests can be that program. */
export interface RenameStep {
    rename(from: string, to: string): Promise<void>
    platform: NodeJS.Platform
    wait(ms: number): Promise<unknown>
}

const REAL: RenameStep = { rename, platform: process.platform, wait: delay }

/** Windows refuses to replace a file another program has open, and says so in three ways. */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES'])

export async function renameWithPatience(from: string, to: string, step: RenameStep = REAL): Promise<void> {
    for (const wait of [...RENAME_WAITS_MS, null]) {
        try {
            return await step.rename(from, to)
        } catch (error) {
            if (step.platform !== 'win32' || !HELD.has(codeOf(error) ?? '')) throw error
            if (wait === null) throw new NativeFailure('InvalidStateError', 'Another program has the file open.')
            await step.wait(wait)
        }
    }
}

export function temporaryBeside(path: string): string {
    return join(dirname(path), `${TEMP_PREFIX}${randomBytes(8).toString('hex')}${TEMP_SUFFIX}`)
}

/** The permission bits of the file about to be replaced, or null when there is none. */
async function modeOf(path: string): Promise<number | null> {
    try {
        const stats = await stat(path)
        if (stats.isDirectory()) throw new NativeFailure('TypeMismatchError', 'A folder is there.')
        // A rename needs no permission on the file it replaces, so a read-only file is checked here.
        await access(path, constants.W_OK)
        return stats.mode & 0o7777
    } catch (error) {
        if (isMissing(error)) return null
        throw error
    }
}

/**
 * Write a flushed temporary file beside `path`, with the mode of what it will replace. The stamp is
 * the temporary file's own, which a rename or a hard link keeps: read from the path after the rename
 * instead, it could be another program's write that came in between.
 */
export async function writeTemporary(path: string, bytes: Uint8Array): Promise<{ temporary: string; stamp: FileStamp }> {
    const mode = await modeOf(path)
    const temporary = temporaryBeside(path)
    const handle = await open(temporary, 'wx', 0o666)
    let stamp: FileStamp
    try {
        await handle.writeFile(bytes)
        if (mode !== null && process.platform !== 'win32') await handle.chmod(mode)
        await handle.sync()
        stamp = stampOf(await handle.stat({ bigint: true }))
    } catch (error) {
        await handle.close().catch(() => {})
        await rm(temporary, { force: true }).catch(() => {})
        throw error
    }
    await handle.close()
    return { temporary, stamp }
}

/** File systems without hard links (FAT, some network mounts) answer with one of these. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EACCES', 'EINVAL', 'EISDIR', 'UNKNOWN'])

/**
 * Put `temporary` at `path` only if nothing is there. A hard link fails when the name is taken, so
 * another program cannot create the file between a check and a rename and lose it.
 */
async function placeNew(temporary: string, path: string): Promise<void> {
    try {
        await link(temporary, path)
        await rm(temporary, { force: true })
        return
    } catch (error) {
        const code = codeOf(error)
        if (code === 'EEXIST') throw new NativeFailure('NoModificationAllowedError', 'A file is there already.')
        if (!NO_LINKS.has(code ?? '')) throw error
    }
    if (await stat(path).then(() => true, () => false)) throw new NativeFailure('NoModificationAllowedError', 'A file is there already.')
    await renameWithPatience(temporary, path)
}

/**
 * Move a file to a name where nothing is, with a hard link and then the old name's removal, so a file
 * another program creates at `to` meanwhile is refused rather than replaced. False where the file
 * system has no hard links, and then the caller renames.
 */
export async function moveToNewName(from: string, to: string): Promise<boolean> {
    try {
        await link(from, to)
    } catch (error) {
        const code = codeOf(error)
        if (code === 'EEXIST') throw new NativeFailure('InvalidModificationError', 'Something is already there.')
        if (NO_LINKS.has(code ?? '')) return false
        throw error
    }
    try {
        await rm(from, { maxRetries: 5, retryDelay: 50 })
    } catch (error) {
        // Two names for one file would be a copy the person did not make. Back to the one they had.
        await rm(to, { force: true }).catch(() => {})
        throw error
    }
    return true
}

export interface ReplaceOptions {
    /** Nothing may be at the path. */
    onlyNew?: boolean
    /** Run after the bytes are on the disk and before they take the file's place. Throws to stop. */
    beforePlacing?: () => Promise<void>
}

/** The one writer. The caller holds the file's lock. Answers the stamp of the bytes it put there. */
export async function replaceFile(path: string, bytes: Uint8Array, { onlyNew = false, beforePlacing }: ReplaceOptions = {}): Promise<FileStamp> {
    const { temporary, stamp } = await writeTemporary(path, bytes)
    try {
        await beforePlacing?.()
        if (onlyNew) await placeNew(temporary, path)
        else await renameWithPatience(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
    }
    return stamp
}
