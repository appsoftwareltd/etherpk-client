import { type EntitlementLimits, formatBytes } from '@appsoftwareltd/etherpk-shared'
import type { SourceFile } from './types'

/** 4 MiB, matching the Server Asset Store's chunking - the chunk allowance is in these units. */
const CHUNK_SIZE = 4 * 1024 * 1024

export interface OversizeAsset {
    path: string
    bytes: number
    reason: 'size' | 'chunks'
}

/**
 * Which of a source's files the account's [[Entitlement]] will refuse, worked out before the
 * import starts. Both the limits and the sizes are known up front, so a refusal that would
 * otherwise surface eight minutes into a background run can be a sentence in the dialog instead.
 *
 * Markdown is never checked: documents travel as encrypted updates over the sync session, not as
 * assets, so the per-asset allowance does not apply to them.
 */
export function oversizeAssets(files: SourceFile[], limits: Pick<EntitlementLimits, 'assetBytes' | 'assetChunks'>): OversizeAsset[] {
    const oversize: OversizeAsset[] = []
    for (const file of files) {
        if (isMarkdown(file.path)) continue
        const bytes = file.data.size
        if (bytes > limits.assetBytes) {
            oversize.push({ path: file.path, bytes, reason: 'size' })
            continue
        }
        if (Math.max(1, Math.ceil(bytes / CHUNK_SIZE)) > limits.assetChunks) {
            oversize.push({ path: file.path, bytes, reason: 'chunks' })
        }
    }
    return oversize
}

/** "big.bin (312 MiB)" - the shape the dialog and the Import Report both want. */
export function describeOversize(asset: OversizeAsset): string {
    const name = asset.path.split('/').pop() ?? asset.path
    return `${name} (${formatBytes(asset.bytes)})`
}

function isMarkdown(path: string): boolean {
    return /\.mdx?$/i.test(path)
}
