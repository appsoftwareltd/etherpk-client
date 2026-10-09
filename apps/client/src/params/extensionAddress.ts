/**
 * Matches the first segment of an address a Built-in Extension declares for one of its View kinds
 * (ADR 0121): `k` in `/g/<graph>/k/<concept>`, `graph-view` in `/g/<graph>/graph-view`. Any other
 * segment does not match, so an unknown address is a 404 rather than an empty workspace, and the
 * Client's own routes (`d`, `a`, `t`) are never reached here, being static.
 */
import { DECLARED_SEGMENTS } from '$lib/extensions/declared-segments'

export function match(param: string): boolean {
    return DECLARED_SEGMENTS.has(param)
}
