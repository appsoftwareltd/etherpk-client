/**
 * One retry for the write fault that is transient by nature.
 *
 * The File System Access API writes to a swap file and, at `close()`, renames it over the
 * target. On Windows that rename is refused while any other process holds the target open, even
 * for a read of a few milliseconds: a virus scanner or search indexer reacting to the last save,
 * an editor with the folder open, the Headless Client serving it. Chromium reports the refusal
 * as `InvalidStateError` with a sentence about "state cached in an interface object", its
 * catch-all for a failed file operation; the Windows error behind it is discarded
 * ([[Filesystem Backend]] → Reconciliation). Nothing about the file is wrong, so the write is
 * tried once more after a short pause before anyone hears of it. A second refusal surfaces as
 * it is: the store keeps the buffer dirty and the notice's Retry re-runs the write.
 *
 * Pure, so the policy is unit tested; the browser adapter wraps each of its writes in it.
 */

export const TRANSIENT_WRITE_RETRY_MS = 300

/** Chromium's catch-all file failure; in practice, a rename refused because the target was open. */
export function isTransientWriteFault(error: unknown): boolean {
    return error instanceof Error && error.name === 'InvalidStateError'
}

export interface WriteRetryOptions {
    delayMs?: number
    /** Injected for tests; the real one is a `setTimeout`. */
    sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function writeWithOneRetry<T>(attempt: () => Promise<T>, options: WriteRetryOptions = {}): Promise<T> {
    try {
        return await attempt()
    } catch (error) {
        if (!isTransientWriteFault(error)) throw error
        await (options.sleep ?? wait)(options.delayMs ?? TRANSIENT_WRITE_RETRY_MS)
        return attempt()
    }
}
