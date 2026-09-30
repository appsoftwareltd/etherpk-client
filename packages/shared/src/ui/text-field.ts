/**
 * The classes of a text field on the Sync Server and Corporate forms: the sign-in, registration,
 * password, contact and account pages, and the two-factor step.
 *
 * Every form takes them from here so the valid and invalid states are defined once. The class
 * names are also what each app's dark theme hooks onto: `html.dark [class~="bg-white"]`,
 * `[class~="border-gray-300"]` and `[class~="text-gray-950"]` in `app.css` repaint the field for
 * the dark surface, so a class swapped here needs a matching rule there.
 */

/** Shape, size and focus treatment, the same for every standard field. */
const TEXT_FIELD_BASE = 'block w-full rounded-lg border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 transition-colors'

const VALID = 'border-gray-300 text-gray-950 focus:border-gray-950 focus:ring-gray-950/10'

/**
 * The typed text keeps the valid field's colour, so it reads the same in both themes. The error
 * is marked by the red border, by the message the form renders under the field and by the
 * `aria-invalid` it sets. Red-500 holds at least 3:1 (WCAG 1.4.11) against the field in both
 * themes, and the dark theme leaves it as it is.
 */
const INVALID = 'border-red-500 text-gray-950 focus:ring-red-500/10'

/**
 * A field's border, text colour and focus colours for its state. For a field that needs its own
 * shape or size (the two-factor code is large and centred) beside the shared state.
 */
export function textFieldState(invalid: boolean): string {
    return invalid ? INVALID : VALID
}

/** A standard field's full class list. Append layout-only classes (`resize-y`) after it. */
export function textFieldClass(invalid: boolean): string {
    return `${TEXT_FIELD_BASE} ${textFieldState(invalid)}`
}
