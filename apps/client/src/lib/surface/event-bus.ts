/**
 * The Event bus implementation. One bus belongs to one knowledge graph: it is
 * created with that graph's id and injects it into every payload, so the bus
 * instance *is* the graph scope — a listener on this bus can only ever observe
 * this graph's events
 * (docs/adr/0014-surface-is-app-global-but-graph-scoped-delivery-is-mandatory.md).
 *
 * Dispatch is synchronous and in registration order; a listener that throws is
 * isolated (logged, then skipped) so it can neither stop sibling listeners nor
 * escape `emit` — the structural guarantee that an Event is observe-only and not
 * a Hook.
 */

import type { EventBus, EventName, EventPayloads } from './types'

export function createEventBus(graphId: string): EventBus {
    // One listener set per event name. A Set gives O(1) add/remove and natural
    // dedupe; insertion order is preserved, which is the documented dispatch order.
    const listeners = new Map<EventName, Set<(payload: never) => void>>()

    return {
        emit(name, payload) {
            const set = listeners.get(name)
            if (!set) return
            const full = { ...payload, graphId } as EventPayloads[typeof name]
            // Snapshot so a listener that subscribes/unsubscribes during dispatch
            // does not perturb this emit.
            for (const listener of [...set]) {
                try {
                    ;(listener as (p: EventPayloads[typeof name]) => void)(full)
                } catch (err) {
                    // Observe-only: a buggy observer must not corrupt the producer
                    // or its siblings. Log and carry on.
                    console.error(`event listener for "${name}" threw`, err)
                }
            }
        },

        on(name, listener) {
            let set = listeners.get(name)
            if (!set) {
                set = new Set()
                listeners.set(name, set)
            }
            const entry = listener as (payload: never) => void
            set.add(entry)
            let disposed = false
            return () => {
                if (disposed) return
                disposed = true
                set.delete(entry)
            }
        },
    }
}
