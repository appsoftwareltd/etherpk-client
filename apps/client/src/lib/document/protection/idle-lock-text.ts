/** When the graph's protected documents lock by themselves, as the Protected Documents View says it. */
export function idleLockText(idleLockMs: number): string {
    if (idleLockMs <= 0) return 'Does not lock after a time without activity.'
    return `Locks after ${duration(idleLockMs)} without activity.`
}

function duration(ms: number): string {
    const seconds = Math.round(ms / 1000)
    const [count, unit] = seconds >= 3600 && seconds % 3600 === 0 ? [seconds / 3600, 'hour'] : seconds >= 60 ? [Math.round(seconds / 60), 'minute'] : [seconds, 'second']
    return `${count} ${unit}${count === 1 ? '' : 's'}`
}
