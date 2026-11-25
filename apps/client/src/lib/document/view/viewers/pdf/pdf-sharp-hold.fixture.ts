import type { SharpClock } from './pdf-sharp-hold'

/** A clock a test moves by hand, with the timers due run in order. */
export function handClock() {
    let now = 0
    let next = 1
    const timers = new Map<number, { at: number; run: () => void }>()
    const clock: SharpClock = {
        now: () => now,
        setTimer: (run, ms) => {
            timers.set(next, { at: now + ms, run })
            return next++
        },
        clearTimer: (timer) => void timers.delete(timer as number),
    }
    const pass = (ms: number) => {
        const until = now + ms
        for (;;) {
            const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
            if (!due) break
            timers.delete(due[0])
            now = due[1].at
            due[1].run()
        }
        now = until
    }
    return { clock, pass, now: () => now }
}
