/**
 * Whether `promise` settled within `timeoutMs`. A milestone that never arrives (offline, a silent
 * server, an index that keeps being handed changes) is a bounded wait and a `false`, never a hang
 * and never an unhandled rejection: the caller decides what an unreached milestone means.
 */
export async function reachedWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise.then(
                () => true,
                () => false,
            ),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
