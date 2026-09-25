/**
 * Content-free performance diagnostics for graph and editor hot paths.
 *
 * Recording is opt-in so normal sessions do not retain timing data. Callers use stable
 * operation names and numeric dimensions only. Concepts, note text, key material and
 * ciphertext must never be passed as labels or detail.
 */
export interface PerformanceMetric {
    name: string
    durationMs: number
    at: number
    dimensions: Readonly<Record<string, number>>
}

export interface PerformanceRecorder {
    measure<T>(
        name: string,
        dimensions: Readonly<Record<string, number>>,
        operation: () => T,
    ): T
    measureAsync<T>(
        name: string,
        dimensions: Readonly<Record<string, number>>,
        operation: () => Promise<T>,
    ): Promise<T>
    mark(name: string, dimensions?: Readonly<Record<string, number>>): void
    snapshot(): PerformanceMetric[]
    clear(): void
}

function assertSafeName(name: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) {
        throw new Error('Performance metric names may contain only lower-case stable identifiers')
    }
}

export function createPerformanceRecorder(options: {
    enabled: boolean
    now?: () => number
    capacity?: number
}): PerformanceRecorder {
    const now = options.now ?? (() => performance.now())
    const capacity = options.capacity ?? 2_000
    const metrics: PerformanceMetric[] = []

    function record(
        name: string,
        startedAt: number,
        dimensions: Readonly<Record<string, number>>,
    ): void {
        if (!options.enabled) return
        assertSafeName(name)
        const endedAt = now()
        metrics.push({
            name,
            durationMs: Math.max(0, endedAt - startedAt),
            at: endedAt,
            dimensions: { ...dimensions },
        })
        if (metrics.length > capacity) metrics.splice(0, metrics.length - capacity)

        if (typeof performance !== 'undefined' && performance.mark && performance.measure) {
            const start = `etherpk.${name}.start`
            const end = `etherpk.${name}.end`
            performance.mark(start, { startTime: startedAt })
            performance.mark(end, { startTime: endedAt })
            performance.measure(`etherpk.${name}`, start, end)
            performance.clearMarks(start)
            performance.clearMarks(end)
        }
    }

    return {
        measure(name, dimensions, operation) {
            if (!options.enabled) return operation()
            assertSafeName(name)
            const startedAt = now()
            try {
                return operation()
            } finally {
                record(name, startedAt, dimensions)
            }
        },
        async measureAsync(name, dimensions, operation) {
            if (!options.enabled) return operation()
            assertSafeName(name)
            const startedAt = now()
            try {
                return await operation()
            } finally {
                record(name, startedAt, dimensions)
            }
        },
        mark(name, dimensions = {}) {
            if (!options.enabled) return
            assertSafeName(name)
            const at = now()
            metrics.push({ name, durationMs: 0, at, dimensions: { ...dimensions } })
            if (metrics.length > capacity) metrics.splice(0, metrics.length - capacity)
            performance.mark(`etherpk.${name}`)
        },
        snapshot: () => metrics.map((metric) => ({ ...metric, dimensions: { ...metric.dimensions } })),
        clear: () => {
            metrics.length = 0
        },
    }
}

export const performanceRecorder = createPerformanceRecorder({
    enabled: typeof window !== 'undefined' && import.meta.env.DEV,
})
