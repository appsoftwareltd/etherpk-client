import { describe, expect, it, vi } from 'vitest'
import { createBetterAuthLogger, type AppLogger } from './better-auth-logger'

function appLogger() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } satisfies AppLogger
}

describe('createBetterAuthLogger', () => {
    it('writes a failed sign-in through the JSON logger at warn, without the address tried', () => {
        // better-auth 1.6.15 sign-in.mjs: ctx.context.logger.error('User not found', { email })
        const logger = appLogger()
        createBetterAuthLogger(logger).log?.('error', 'User not found', { email: 'probe@example.com' })

        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledWith('better-auth: User not found', {
            detail: [{ email: '[redacted]' }],
        })
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('probe@example.com')
    })

    it('removes an address wherever it appears, not only under an `email` key', () => {
        const logger = appLogger()
        createBetterAuthLogger(logger).log?.(
            'warn',
            'Reset Password: User not found',
            'for person@example.org',
            { user: { contact: 'Person <person@example.org>', newEmail: 'x@y.test' } },
        )

        const written = JSON.stringify(logger.warn.mock.calls)
        expect(written).not.toContain('person@example.org')
        expect(written).not.toContain('x@y.test')
        expect(logger.warn).toHaveBeenCalledWith('better-auth: Reset Password: User not found', {
            detail: [
                'for [redacted email]',
                { user: { contact: 'Person <[redacted email]>', newEmail: '[redacted]' } },
            ],
        })
    })

    it('never writes a credential the library hands it', () => {
        const logger = appLogger()
        createBetterAuthLogger(logger).log?.('error', 'Invalid password', { password: 'hunter2', token: 'abc' })

        expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/hunter2|"abc"/)
    })

    it('leaves a genuine library failure at error, with its stack', () => {
        // A thrown Error, such as the database refusing a write, is not a user's mistake: it must
        // still raise an error-level line an operator can alert on, and carry the stack.
        const logger = appLogger()
        const failure = new TypeError('connection refused for owner@example.com')
        createBetterAuthLogger(logger).log?.('error', 'Error setting rate limit', failure)

        expect(logger.warn).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledWith('better-auth: Error setting rate limit', {
            detail: [{
                name: 'TypeError',
                message: 'connection refused for [redacted email]',
                stack: expect.stringContaining('at '),
            }],
        })
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('owner@example.com')
    })

    it('passes the other levels through unchanged and omits an empty detail', () => {
        const logger = appLogger()
        const adapter = createBetterAuthLogger(logger)
        adapter.log?.('warn', 'Rate limiting skipped')
        adapter.log?.('info', 'Migrations applied')
        adapter.log?.('debug', 'Session refreshed')

        expect(logger.warn).toHaveBeenCalledWith('better-auth: Rate limiting skipped', undefined)
        expect(logger.info).toHaveBeenCalledWith('better-auth: Migrations applied', undefined)
        expect(logger.debug).toHaveBeenCalledWith('better-auth: Session refreshed', undefined)
    })

    it('asks the library for warnings and errors only, as its own default does', () => {
        expect(createBetterAuthLogger(appLogger()).level).toBe('warn')
    })
})
