/** The reference a document would use for this Asset, built from a tab's identity and its name. */
export function assetRefOf(target: string, name: string): string {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]+)?$/.test(target)
    if (!isUuid) return `../assets/${target}`
    // A synced reference wears a stem around the id it resolves by.
    const id = target.slice(0, 36)
    const stem = name.replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'
    return `../assets/${stem}.${id}.pdf`
}
