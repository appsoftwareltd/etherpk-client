/** Where the sign-in is kept between runs: one file, encrypted by the operating system's own key store. */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceFile } from '../fs/atomic-write.ts'

/** Electron's safeStorage, or its stand-in. Null when the system has nowhere to keep a key. */
export interface Sealer {
    seal(text: string): Buffer
    unseal(bytes: Buffer): string
}

export interface TokenStore {
    /** Whether a sign-in is still there after a restart. */
    readonly lasting: boolean
    load(): Promise<string | null>
    save(refreshToken: string): Promise<void>
    clear(): Promise<void>
}

/** Kept in memory only, so each start of the app asks for a sign-in again. */
export function memoryStore(): TokenStore {
    return { lasting: false, load: async () => null, save: async () => {}, clear: async () => {} }
}

export function fileStore(file: string, issuer: string, sealer: Sealer, log: (message: string, error: unknown) => void): TokenStore {
    const clear = () => rm(file, { force: true })
    return {
        lasting: true,
        async load() {
            const bytes = await readFile(file).catch(() => null)
            if (bytes === null) return null
            try {
                const kept = JSON.parse(sealer.unseal(bytes)) as { issuer?: unknown; refreshToken?: unknown } | null
                return kept?.issuer === issuer && typeof kept.refreshToken === 'string' ? kept.refreshToken : null
            } catch (error) {
                // Another key store, or a moved data folder. The person signs in again.
                log('The kept sign-in could not be opened.', error)
                return null
            }
        },
        async save(refreshToken) {
            try {
                await mkdir(dirname(file), { recursive: true })
                await replaceFile(file, sealer.seal(JSON.stringify({ issuer, refreshToken })))
            } catch (error) {
                // The token in the file is spent. Using it again would end the account's sign-in on every
                // device, so better none than that one.
                await clear().catch(() => {})
                throw error
            }
        },
        clear,
    }
}
