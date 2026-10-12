/**
 * Matches the first segment of an address an extension declares for one of its View kinds
 * (ADR 0121): `k` in `/g/<graph>/k/<concept>`, `graph-view` in `/g/<graph>/graph-view`, and `x`,
 * under which every Extension Directory extension's addresses are (`/g/<graph>/x/<id>/…`, ADR 0123),
 * whether or not it is installed on this device. Any other segment does not match, so an unknown
 * address is a 404 rather than an empty workspace, and the Client's own routes (`d`, `a`, `t`) are
 * never reached here, being static.
 */
import { DIRECTORY_SEGMENT } from '$lib/extensions/addresses'
import { DECLARED_SEGMENTS } from '$lib/extensions/declared-segments'

export function match(param: string): boolean {
    return param === DIRECTORY_SEGMENT || DECLARED_SEGMENTS.has(param)
}
