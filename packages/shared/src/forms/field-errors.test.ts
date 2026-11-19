import { describe, expect, it } from 'vitest'
import { touchAll, touchOnBlur, visibleErrors } from './field-errors'

describe('visibleErrors', () => {
    it('hides errors for fields the user has not engaged with', () => {
        const errors = { name: 'Name is required', email: 'Email is required' }
        expect(visibleErrors(errors, { name: true })).toEqual({ name: 'Name is required' })
    })

    it('shows nothing before anything is touched', () => {
        expect(visibleErrors({ email: 'Email is required' }, {})).toEqual({})
    })

    it('drops fields that are touched but now valid', () => {
        expect(visibleErrors({} as Record<string, string>, { email: true })).toEqual({})
    })

    it('ignores undefined messages rather than reporting an empty error', () => {
        expect(visibleErrors({ email: undefined }, { email: true })).toEqual({})
    })

    it('never mutates its input', () => {
        const errors = { email: 'Email is required' }
        visibleErrors(errors, { email: true })
        expect(errors).toEqual({ email: 'Email is required' })
    })
})

describe('touchAll', () => {
    it('marks every named field without discarding earlier ones', () => {
        expect(touchAll({ name: true }, ['email', 'password'])).toEqual({
            name: true,
            email: true,
            password: true,
        })
    })

    it('returns a new record', () => {
        const touched = { name: true }
        expect(touchAll(touched, ['email'])).not.toBe(touched)
        expect(touched).toEqual({ name: true })
    })
})

describe('touchOnBlur', () => {
    it('leaves a field untouched when the person left it without typing in it', () => {
        // Clicking a social button out of the empty email field must not outline it in red.
        expect(touchOnBlur({}, 'email', {})).toEqual({})
    })

    it('marks a field touched once the person has typed in it, even if they emptied it again', () => {
        expect(touchOnBlur({}, 'email', { email: true })).toEqual({ email: true })
    })

    it('keeps a field touched that already was, so an error once shown stays eager', () => {
        expect(touchOnBlur({ email: true }, 'email', {})).toEqual({ email: true })
    })

    it('touches only the field that was left', () => {
        expect(touchOnBlur({ name: true }, 'email', { email: true, password: true })).toEqual({ name: true, email: true })
    })

    it('returns a new record', () => {
        const touched = {}
        expect(touchOnBlur(touched, 'email', { email: true })).not.toBe(touched)
    })
})
