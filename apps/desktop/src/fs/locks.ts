/**
 * One task at a time for each key. A check-then-write (`ifStamp`, a move that must not replace)
 * reads, waits, then writes, so two of them on one file may not interleave.
 */
export class Locks {
    private readonly tails = new Map<string, Promise<unknown>>()

    run<T>(key: string, task: () => Promise<T>): Promise<T> {
        const before = this.tails.get(key) ?? Promise.resolve()
        const result = before.then(task, task)
        const tail = result.catch(() => {}).finally(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key)
        })
        this.tails.set(key, tail)
        return result
    }

    /** Both keys held, taken in one order so that two callers naming them in turn cannot wait on each other. */
    runBoth<T>(a: string, b: string, task: () => Promise<T>): Promise<T> {
        if (a === b) return this.run(a, task)
        const [first, second] = a < b ? [a, b] : [b, a]
        return this.run(first, () => this.run(second, task))
    }

    get size(): number {
        return this.tails.size
    }
}
