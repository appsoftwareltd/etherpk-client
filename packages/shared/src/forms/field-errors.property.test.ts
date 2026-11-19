import { describe, expect, it } from 'vitest'
import { touchAll, touchOnBlur, visibleErrors } from './field-errors'

/**
 * The auth forms' field-error rules, checked over every sequence of what a person can do to a
 * three-field form, up to `FIELD_ERRORS_DEPTH` steps (4 by default: 10,000 sequences). This
 * package has no fast-check, and the space is small enough to walk whole, which beats sampling it.
 *
 * The form is modelled as the pages drive it: typing records the field in `typedIn`, leaving a
 * field runs `touchOnBlur`, submitting runs `touchAll`, and what shows is `visibleErrors` of a
 * "required" check.
 */
const FIELDS = ['name', 'email', 'password'] as const
type Field = (typeof FIELDS)[number]
type Step = { kind: 'type'; field: Field; empty: boolean } | { kind: 'blur'; field: Field } | { kind: 'submit' }

const STEPS: Step[] = [
    ...FIELDS.flatMap((field) => [
        { kind: 'type', field, empty: false } as const,
        { kind: 'type', field, empty: true } as const,
        { kind: 'blur', field } as const,
    ]),
    { kind: 'submit' },
]

function* sequences(depth: number): Generator<Step[]> {
    if (depth === 0) {
        yield []
        return
    }
    for (const shorter of sequences(depth - 1)) {
        yield shorter
        if (shorter.length === depth - 1) for (const step of STEPS) yield [...shorter, step]
    }
}

function run(steps: Step[]) {
    const values: Record<Field, string> = { name: '', email: '', password: '' }
    const typedIn: Record<string, boolean> = {}
    let touched: Record<string, boolean> = {}
    let submitted = false
    const history: Record<string, string | undefined>[] = []
    for (const step of steps) {
        if (step.kind === 'type') {
            values[step.field] = step.empty ? '' : 'x'
            typedIn[step.field] = true
        } else if (step.kind === 'blur') {
            touched = touchOnBlur(touched, step.field, typedIn)
        } else {
            touched = touchAll(touched, FIELDS)
            submitted = true
        }
        const errors = Object.fromEntries(FIELDS.map((field) => [field, values[field] ? undefined : 'required']))
        history.push(visibleErrors(errors, touched))
    }
    return { values, typedIn, submitted, history }
}

const DEPTH = Number(process.env.FIELD_ERRORS_DEPTH ?? 4)

describe('field errors over every sequence of steps', () => {
    it('reports a field only once the person has typed in it or submitted the form', () => {
        for (const steps of sequences(DEPTH)) {
            const { typedIn, submitted, history } = run(steps)
            const shown = history.at(-1) ?? {}
            for (const field of Object.keys(shown)) {
                expect(typedIn[field] || submitted, JSON.stringify(steps)).toBe(true)
            }
        }
    })

    it('reports every empty field once the form has been submitted', () => {
        for (const steps of sequences(DEPTH)) {
            const { values, submitted, history } = run(steps)
            if (!submitted) continue
            const shown = history.at(-1) ?? {}
            for (const field of FIELDS) expect(Boolean(shown[field]), JSON.stringify(steps)).toBe(values[field] === '')
        }
    })

    it('keeps a field that has reported an error eager: it reports again whenever it is empty', () => {
        for (const steps of sequences(DEPTH)) {
            const { values, history } = run(steps)
            const reported = new Set(history.flatMap((shown) => Object.keys(shown)))
            const last = history.at(-1) ?? {}
            for (const field of reported) {
                if (values[field as Field] === '') expect(last[field], JSON.stringify(steps)).toBe('required')
            }
        }
    })
})
