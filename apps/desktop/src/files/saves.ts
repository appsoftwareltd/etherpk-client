/**
 * Saving a copy where the person says. The parts go to a temporary file beside the place chosen, and
 * take its name on commit, so a save that stops half way leaves what was there before.
 */
import { randomBytes } from 'node:crypto'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { NativeFailure } from '../failure.ts'
import { renameWithPatience, temporaryBeside } from '../fs/atomic-write.ts'

interface Save { owner: number; path: string; temporary: string; handle: FileHandle; busy: Promise<unknown> }

/**
 * A name to offer in the save dialog, from one the page gave. The person sees it and can change it, and
 * this takes out what is not a name: directories, control characters, what Windows refuses.
 */
export function offeredName(name: string): string {
    const last = name.split(/[\\/]/).at(-1) ?? ''
    // eslint-disable-next-line no-control-regex -- control characters are what is taken out
    const cleaned = last.replace(/[\u0000-\u001f<>:"|?*]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 200)
    return cleaned || 'Untitled'
}

export class Saves {
    private readonly open_ = new Map<string, Save>()

    async open(owner: number, path: string): Promise<{ save: string; name: string }> {
        const temporary = temporaryBeside(path)
        const handle = await open(temporary, 'wx', 0o666)
        const save = `save-${randomBytes(16).toString('hex')}`
        this.open_.set(save, { owner, path, temporary, handle, busy: Promise.resolve() })
        return { save, name: basename(path).normalize('NFC') }
    }

    private find(owner: number, id: string): Save {
        const save = this.open_.get(id)
        if (!save || save.owner !== owner) throw new NativeFailure('NotFoundError', 'The save is over.')
        return save
    }

    /** Parts are written in the order they were sent, whatever each takes. */
    private after<T>(save: Save, task: () => Promise<T>): Promise<T> {
        const result = save.busy.then(task)
        save.busy = result.catch(() => {})
        return result
    }

    async write(owner: number, id: string, bytes: Uint8Array): Promise<void> {
        const save = this.find(owner, id)
        await this.after(save, () => save.handle.writeFile(bytes))
    }

    async commit(owner: number, id: string): Promise<void> {
        const save = this.find(owner, id)
        this.open_.delete(id)
        await this.after(save, async () => {
            try {
                await save.handle.sync()
                await save.handle.close()
                await renameWithPatience(save.temporary, save.path)
            } catch (error) {
                await this.discard(save)
                throw error
            }
        })
    }

    async abort(owner: number, id: string): Promise<void> {
        const save = this.open_.get(id)
        if (!save || save.owner !== owner) return
        this.open_.delete(id)
        await this.after(save, () => this.discard(save))
    }

    private async discard(save: Save): Promise<void> {
        await save.handle.close().catch(() => {})
        await rm(save.temporary, { force: true })
    }

    /** A window that went away left its saves unfinished. */
    async release(owner: number): Promise<void> {
        for (const [id, save] of [...this.open_]) if (save.owner === owner) await this.abort(owner, id).catch(() => {})
    }
}
