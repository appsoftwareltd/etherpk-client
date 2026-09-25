/**
 * Presentation for a View whose `kind` has no registered component.
 *
 * This is expected, not exceptional: a persisted (and, in future, per-user
 * synced) Layout can reference a kind contributed by an extension that is
 * disabled, uninstalled, or simply not present on this device. The instance is
 * never dropped — its tab is kept and the real View slots in if the kind is
 * later registered — so the renderer shows this placeholder in the body rather
 * than erroring or rendering blank.
 */
export function unavailableViewMessage(kind: string): string {
    return `This view (“${kind}”) isn’t available here — the extension that provides it may be disabled or not installed.`
}
