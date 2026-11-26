/**
 * Functions pdf.js 6 calls that a browser a person has today may lack: `Math.sumPrecise` (Chrome 147,
 * Safari 26.2) and `getOrInsert` with `getOrInsertComputed` on Map and WeakMap (Chrome 145). Without
 * the second the reader does not start, and without the first a PDF's own fonts are not used
 * (`tests-client/pdf-older-browser.test.ts`).
 *
 * Imported for its effect, first, by the page that loads pdf.js and by its worker. Each is written as
 * the language defines it, because whatever else the page loads sees it too.
 */

const MAX_DOUBLE = Number.MAX_VALUE
/** The gap between the two largest numbers. */
const MAX_ULP = 2 ** 971
const TWO_POW_1023 = 2 ** 1023

/** `x + y` and what rounding it lost, for `|x| >= |y|`. */
function twoSum(x: number, y: number): [high: number, low: number] {
    const high = x + y
    return [high, y - (high - x)]
}

/**
 * Add `value` to a sum kept as numbers that do not overlap, smallest first. Answers with 1 or -1 when the
 * top passed 2^1024 in either direction, which is then taken off it, and 0 otherwise.
 */
function addTo(partials: number[], value: number): number {
    let x = value
    let overflow = 0
    let used = 0
    for (const partial of partials) {
        let sum = twoSum(...byMagnitude(x, partial))
        if (Math.abs(sum[0]) === Infinity) {
            const sign = Math.sign(sum[0])
            const [larger, smaller] = byMagnitude(x, partial)
            overflow += sign
            sum = twoSum(...byMagnitude(larger - sign * TWO_POW_1023 - sign * TWO_POW_1023, smaller))
        }
        if (sum[1] !== 0) partials[used++] = sum[1]
        x = sum[0]
    }
    partials.length = used
    if (x !== 0) partials.push(x)
    return overflow
}

/** The two with the larger first, as {@link twoSum} takes them. */
function byMagnitude(x: number, y: number): [number, number] {
    return Math.abs(x) < Math.abs(y) ? [y, x] : [x, y]
}

/** The top of a sum that passed 2^1024 and may have come back below it, or the infinity it rounds to. */
function foldOverflow(partials: number[], overflow: number): number | null {
    const next = partials.pop() ?? 0
    const sign = Math.sign(overflow)
    if (Math.abs(overflow) > 1 || Math.sign(next) === sign) return sign * Infinity
    // Halved, so that it can be held, and doubled again once it is known to fit.
    const [high, halfLow] = twoSum(overflow * TWO_POW_1023, next / 2)
    const low = halfLow * 2
    if (Math.abs(2 * high) === Infinity) return sign * (justBelowInfinity(high, low, partials.at(-1), sign) ? MAX_DOUBLE : Infinity)
    if (low !== 0) partials.push(low)
    partials.push(high * 2)
    return null
}

/** Whether a sum is halfway to what would round to infinity, with what is left of it pulling it back. */
function justBelowInfinity(high: number, low: number, left: number | undefined, sign: number): boolean {
    return high === sign * TWO_POW_1023 && low === -sign * (MAX_ULP / 2) && left !== undefined && Math.sign(left) === -sign
}

/** The partials added from the top, rounded once. */
function roundPartials(partials: readonly number[]): number {
    let at = partials.length - 1
    let high = 0
    let low = 0
    while (at >= 0) {
        ;[high, low] = twoSum(high, partials[at--])
        if (low !== 0) break
    }
    // Halfway between two numbers: what is left below decides which way it goes.
    if (at >= 0 && Math.sign(low) === Math.sign(partials[at])) {
        const doubled = low * 2
        const rounded = high + doubled
        if (doubled === rounded - high) high = rounded
    }
    return high
}

/** The sum of the numbers as if added with no rounding, then rounded once. */
export function sumPrecise(numbers: Iterable<number>): number {
    const partials: number[] = []
    let overflow = 0
    // Only a sum of nothing but -0 is -0, and an empty one is -0 as well.
    let zero = -0
    let special = 0
    for (const value of numbers) {
        if (typeof value !== 'number') throw new TypeError('Math.sumPrecise takes numbers')
        // Infinity and -Infinity together are not a number, as their sum is.
        if (!Number.isFinite(value)) special += value
        else overflow += addTo(partials, value)
        if (!Object.is(value, -0)) zero = 0
    }
    if (special !== 0) return special
    return rounded(partials, overflow) ?? zero
}

/** The number a sum rounds to, or null for a sum with nothing in it. */
function rounded(partials: number[], overflow: number): number | null {
    const infinite = overflow === 0 ? null : foldOverflow(partials, overflow)
    if (infinite !== null) return infinite
    return partials.length === 0 ? null : roundPartials(partials)
}

interface Keyed<K, V> {
    has(key: K): boolean
    get(key: K): V | undefined
    set(key: K, value: V): unknown
}

function getOrInsert<K, V>(this: Keyed<K, V>, key: K, value: V): V {
    if (this.has(key)) return this.get(key)!
    this.set(key, value)
    return value
}

function getOrInsertComputed<K, V>(this: Keyed<K, V>, key: K, compute: (key: K) => V): V {
    if (this.has(key)) return this.get(key)!
    const value = compute(key)
    this.set(key, value)
    return value
}

/** Put `value` at `name` where nothing is, the way a built-in is put there. */
function supply(on: object, name: string, value: unknown): void {
    if (name in on) return
    Object.defineProperty(on, name, { value, writable: true, configurable: true, enumerable: false })
}

supply(Math, 'sumPrecise', sumPrecise)
for (const prototype of [Map.prototype, WeakMap.prototype]) {
    supply(prototype, 'getOrInsert', getOrInsert)
    supply(prototype, 'getOrInsertComputed', getOrInsertComputed)
}
