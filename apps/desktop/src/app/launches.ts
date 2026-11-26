/** What the operating system handed to the app, waiting for the page to take it. */
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Launch } from '@appsoftwareltd/etherpk-native-bridge'
import type { Started } from '../launch/arguments.ts'
import type { NativeShell } from '../port/shell.ts'

export interface LaunchesParts {
    shell: Pick<NativeShell, 'addFolder' | 'openedFiles'>
    waiting(): void
    notFound(name: string): void
    log(message: string, error?: unknown): void
}

export class Launches {
    private readonly queue: Launch[] = []
    private last: Promise<void> = Promise.resolve()

    constructor(private readonly parts: LaunchesParts) {}

    take(): Launch[] {
        return this.queue.splice(0)
    }

    /** In the order they came, whatever each takes. */
    add(started: readonly Started[]): Promise<void> {
        for (const one of started) this.last = this.last.then(() => this.addOne(one))
        return this.last
    }

    private async addOne(one: Started): Promise<void> {
        try {
            this.queue.push(one.kind === 'link' ? { kind: 'link', url: one.url } : await this.opened(one.path))
            this.parts.waiting()
        } catch (error) {
            this.parts.log('What the app was opened with could not be opened.', error)
            if (one.kind === 'path') this.parts.notFound(basename(one.path) || one.path)
        }
    }

    private async opened(path: string): Promise<Launch> {
        const { shell } = this.parts
        if ((await stat(path)).isDirectory()) return { kind: 'folder', folder: await shell.addFolder(path) }
        return { kind: 'file', file: await shell.openedFiles.add(path) }
    }
}
