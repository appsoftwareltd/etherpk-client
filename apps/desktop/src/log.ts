/** The app's log, for the person to send when something goes wrong: one file, and the one before it. */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const LONGEST = 1024 * 1024

export function fileLog(file: string, also: (line: string) => void): (message: string, error?: unknown) => void {
    return (message, error) => {
        const detail = error instanceof Error ? (error.stack ?? error.message) : error === undefined || error === null ? '' : String(error)
        const line = `${new Date().toISOString()} ${message}${detail ? ` ${detail}` : ''}\n`
        also(line)
        try {
            mkdirSync(dirname(file), { recursive: true })
            if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LONGEST) renameSync(file, `${file}.1`)
            appendFileSync(file, line)
        } catch {
            // A log that cannot be written is no reason to stop.
        }
    }
}
