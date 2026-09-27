/**
 * A size in bytes for people to read, used by every app so one size reads the same everywhere.
 *
 * The units are binary (KiB, MiB, GiB): every size EtherPK shows, from an allowance of 50 GiB
 * (53,687,091,200 bytes) to a browser's storage estimate, is counted in powers of 1024, and a
 * "GB" beside a binary number is 7% out. Whole numbers from 10 up, one decimal below, and no
 * trailing ".0".
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
    if (bytes < 1024) return `${Math.round(bytes)} B`
    const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
    let value = bytes
    let unit = -1
    do {
        value /= 1024
        unit += 1
    } while (value >= 1024 && unit < units.length - 1)
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`
}
