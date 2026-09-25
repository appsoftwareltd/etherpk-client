/**
 * Human byte formatting for Storage Footprint figures (and anywhere else bytes render).
 * Binary units, one decimal at MB and above, none below - compact enough for panel rows.
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
}
