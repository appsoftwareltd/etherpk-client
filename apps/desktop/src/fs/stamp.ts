import { type BigIntStats } from 'node:fs'
import type { FileStamp } from '@appsoftwareltd/etherpk-native-bridge'

/**
 * A file's stamp. From the whole nanoseconds, since Node's `mtimeMs` is a float that can fall a hair
 * below the millisecond it means, and one instant must not read as two stamps.
 */
export function stampOf(stats: Pick<BigIntStats, 'mtimeNs' | 'size'>): FileStamp {
    return { lastModified: Number(stats.mtimeNs / 1_000_000n), size: Number(stats.size) }
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
    return a.lastModified === b.lastModified && a.size === b.size
}
