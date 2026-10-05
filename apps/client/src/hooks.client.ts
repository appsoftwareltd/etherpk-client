/**
 * Runs in the browser before the app starts, ahead of every page and component module.
 */
import { z } from 'zod'
import { installDefaultPolicy } from '$lib/security/trusted-types'

// The default Trusted Types policy (ADR 0130) must exist before any library writes a string to a
// sink, or the browser refuses the write.
installDefaultPolicy()

// Zod compiles object schemas with `new Function` when it can, and finds out by trying, which
// Trusted Types refuses and reports as a violation on every page. The Client's schemas parse small
// stored records, so the interpreted path costs nothing that shows. Set before any schema is built:
// zod reads it when a schema is made.
z.config({ jitless: true })
