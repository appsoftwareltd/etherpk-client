import { describe, expect, it } from 'vitest'
import { SESSION_ENDED_MESSAGE } from '../navigation/sign-in-path'
import { socialFailureMessage } from './social-failure'

describe('socialFailureMessage', () => {
    it('names the provider and gives the server reason', () => {
        expect(socialFailureMessage('continue with', 'github', { status: 404, message: 'Provider not found' }))
            .toBe('Could not continue with GitHub: Provider not found')
    })

    it('asks for a retry when the server gave no reason', () => {
        expect(socialFailureMessage('connect', 'google', { status: 500 })).toBe('Could not connect Google. Try again.')
    })

    it('reports a 401 as a session that has ended', () => {
        expect(socialFailureMessage('connect', 'github', { status: 401, message: 'Unauthorized' })).toBe(SESSION_ENDED_MESSAGE)
    })
})
