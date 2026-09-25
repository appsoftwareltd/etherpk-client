import { describe, expect, it } from 'vitest'
import { touchAll, visibleErrors } from './field-errors'

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
