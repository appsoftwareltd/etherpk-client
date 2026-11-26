/**
 * What the person has given the app: folders they chose and files they opened, each under an opaque
 * random id. The ids are kept in the app's own data folder, so a graph is still there after a restart.
 * The page holds ids and never a path.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { NativeFailure } from '../failure.ts'
import { replaceFile } from './atomic-write.ts'

type Kind = 'folder' | 'file'
interface Grant { path: string; kind: Kind }
interface Kept { version: 1; grants: Record<string, Grant> }

/** A file is granted by being opened, which happens for ever. The oldest go. */
const FILES_KEPT = 500

function isGrant(value: unknown): value is Grant {
    const grant = value as Partial<Grant> | null
    return typeof grant === 'object' && grant !== null && typeof grant.path === 'string' && (grant.kind === 'folder' || grant.kind === 'file')
}

/** The grants a stored text holds, or null for a text that is not one. */
export function parseGrants(text: string): Map<string, Grant> | null {
    try {
        const kept = JSON.parse(text) as Partial<Kept> | null
        if (kept?.version !== 1 || typeof kept.grants !== 'object' || kept.grants === null) return null
        return new Map(Object.entries(kept.grants).filter((entry): entry is [string, Grant] => isGrant(entry[1])))
    } catch {
        return null
    }
}

export class Grants {
    private grants = new Map<string, Grant>()
    private saving: Promise<void> = Promise.resolve()

    private constructor(private readonly file: string, private readonly log: (message: string, error: unknown) => void) {}

    static async open(file: string, log: (message: string, error: unknown) => void): Promise<Grants> {
        const grants = new Grants(file, log)
        const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
        })
        if (text === null) return grants
        const read = parseGrants(text)
        if (read) {
            grants.grants = read
            return grants
        }
        // Kept under another name for the person to send us, since the next change writes the file anew.
        await replaceFile(`${file}.unreadable`, Buffer.from(text))
        log('The list of chosen folders could not be read. It was set aside.', null)
        return grants
    }

    /** A new id for a path. Each call makes one, so forgetting an id never takes another's folder. */
    async add(kind: Kind, path: string): Promise<string> {
        const id = `${kind}-${randomBytes(16).toString('hex')}`
        this.grants.set(id, { kind, path: resolve(path) })
        this.dropOldFiles()
        await this.save()
        return id
    }

    private dropOldFiles(): void {
        const files = [...this.grants].filter(([, grant]) => grant.kind === 'file')
        for (const [id] of files.slice(0, Math.max(0, files.length - FILES_KEPT))) this.grants.delete(id)
    }

    find(kind: Kind, id: string): string | null {
        const grant = this.grants.get(id)
        return grant?.kind === kind ? grant.path : null
    }

    /** The path an id stands for, or `NotAllowedError`. */
    path(kind: Kind, id: string): string {
        const path = this.find(kind, id)
        if (path === null) throw new NativeFailure('NotAllowedError', `The app has no permission for this ${kind}.`)
        return path
    }

    async forget(kind: Kind, id: string): Promise<void> {
        if (this.find(kind, id) === null) return
        this.grants.delete(id)
        await this.save()
    }

    /** One write at a time, each of everything, so the last one on disk is the newest. */
    private save(): Promise<void> {
        this.saving = this.saving.catch(() => {}).then(async () => {
            const kept: Kept = { version: 1, grants: Object.fromEntries(this.grants) }
            await mkdir(dirname(this.file), { recursive: true })
            await replaceFile(this.file, Buffer.from(`${JSON.stringify(kept, null, 2)}\n`))
        })
        this.saving.catch((error: unknown) => this.log('The list of chosen folders could not be saved.', error))
        return this.saving
    }
}

/** A folder's own name, for display. A drive or the root has none, so its path stands in. */
export function folderName(path: string): string {
    return (basename(path) || path).normalize('NFC')
}
