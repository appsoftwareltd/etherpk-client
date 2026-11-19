/**
 * Which field errors a form may show, and when (AGENTS.md rule 6).
 *
 * These forms validate every field at once and then render whatever comes back. Doing that on
 * blur would light up fields the user has not reached yet, so the rule's "validate on blur,
 * then eagerly once a field has errored" needs a record of which fields the user has actually
 * engaged with. Pure so it can be unit tested; the pages own the `$state` around it.
 */

export type FieldErrors = Record<string, string | undefined>

/**
 * Narrow a full validation result to the fields the user has left or already seen fail.
 *
 * `touched` accumulates on blur and on a failed submit (where every field is touched at once,
 * because the user has now engaged with the form as a whole).
 */
export function visibleErrors<E extends FieldErrors>(errors: E, touched: Readonly<Record<string, boolean>>): E {
    const visible: FieldErrors = {}
    for (const [field, message] of Object.entries(errors)) {
        if (message !== undefined && touched[field]) visible[field] = message
    }
    return visible as E
}

/** Mark every named field touched, e.g. on submit. Returns a new record; never mutates. */
export function touchAll(
    touched: Readonly<Record<string, boolean>>,
    fields: readonly string[],
): Record<string, boolean> {
    const next = { ...touched }
    for (const field of fields) next[field] = true
    return next
}

/**
 * Mark a field touched as the person leaves it, but only once they have typed in it.
 *
 * Clicking into an empty field and out again, tabbing past it, or pressing a Google or GitHub
 * button while the caret is in it, is not finishing with the field: nothing was entered, so
 * "Email is required" would be a complaint about a step the person chose to skip. A submit
 * still reports every empty field (`touchAll`). A field that has errored stays touched, so it
 * keeps correcting itself as the person types. `typedIn` is set from the field's input event,
 * which a browser's autofill fires too.
 */
export function touchOnBlur(
    touched: Readonly<Record<string, boolean>>,
    field: string,
    typedIn: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
    return touched[field] || typedIn[field] ? { ...touched, [field]: true } : { ...touched }
}
