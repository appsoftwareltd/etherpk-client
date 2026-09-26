import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initLoggerFromEnv, shutdownLogger, logger, flush, _resetLogger } from './logger'

describe('logger', () => {
    let consoleSpy: {
        log: ReturnType<typeof vi.spyOn>
        error: ReturnType<typeof vi.spyOn>
        warn: ReturnType<typeof vi.spyOn>
        debug: ReturnType<typeof vi.spyOn>
    }

    beforeEach(() => {
        _resetLogger()
        consoleSpy = {
            log: vi.spyOn(console, 'log').mockImplementation(() => { }),
            error: vi.spyOn(console, 'error').mockImplementation(() => { }),
            warn: vi.spyOn(console, 'warn').mockImplementation(() => { }),
            debug: vi.spyOn(console, 'debug').mockImplementation(() => { })
        }
    })

    afterEach(() => {
        _resetLogger()
        vi.restoreAllMocks()
    })

    describe('console-only mode (no OpenObserve URL)', () => {
        beforeEach(() => {
            initLoggerFromEnv({ logLevel: 'debug' })
            // Clear the startup diagnostic log
            consoleSpy.log.mockClear()
        })

        it('logs info to console.log as JSON', () => {
            logger.info('hello world')

            expect(consoleSpy.log).toHaveBeenCalledOnce()
            const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string)
            expect(parsed).toMatchObject({
                level: 'info',
                message: 'hello world'
            })
            expect(parsed.timestamp).toBeDefined()
        })

        it('logs error to console.error', () => {
            logger.error('something broke', { code: 500 })

            expect(consoleSpy.error).toHaveBeenCalledOnce()
            const parsed = JSON.parse(consoleSpy.error.mock.calls[0][0] as string)
            expect(parsed).toMatchObject({
                level: 'error',
                message: 'something broke',
                code: 500
            })
        })

        it('logs warn to console.warn', () => {
            logger.warn('slow query')
            expect(consoleSpy.warn).toHaveBeenCalledOnce()
        })

        it('logs debug to console.debug', () => {
            logger.debug('trace data')
            expect(consoleSpy.debug).toHaveBeenCalledOnce()
        })

        it('includes extra fields in the JSON output', () => {
            logger.info('request', { method: 'GET', path: '/api/health', duration_ms: 12 })

            const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string)
            expect(parsed.method).toBe('GET')
            expect(parsed.path).toBe('/api/health')
            expect(parsed.duration_ms).toBe(12)
        })
    })

    describe('log level filtering', () => {
        it('filters out debug when level is info', () => {
            initLoggerFromEnv({ logLevel: 'info' })
            consoleSpy.log.mockClear()
            logger.debug('should not appear')
            expect(consoleSpy.debug).not.toHaveBeenCalled()
        })

        it('allows info when level is info', () => {
            initLoggerFromEnv({ logLevel: 'info' })
            consoleSpy.log.mockClear()
            logger.info('visible')
            expect(consoleSpy.log).toHaveBeenCalledOnce()
        })

        it('filters out info and debug when level is warn', () => {
            initLoggerFromEnv({ logLevel: 'warn' })
            consoleSpy.log.mockClear()
            logger.debug('no')
            logger.info('no')
            logger.warn('yes')
            expect(consoleSpy.debug).not.toHaveBeenCalled()
            expect(consoleSpy.log).not.toHaveBeenCalled()
            expect(consoleSpy.warn).toHaveBeenCalledOnce()
        })

        it('only allows error when level is error', () => {
            initLoggerFromEnv({ logLevel: 'error' })
            consoleSpy.log.mockClear()
            logger.debug('no')
            logger.info('no')
            logger.warn('no')
            logger.error('yes')
            expect(consoleSpy.debug).not.toHaveBeenCalled()
            expect(consoleSpy.log).not.toHaveBeenCalled()
            expect(consoleSpy.warn).not.toHaveBeenCalled()
            expect(consoleSpy.error).toHaveBeenCalledOnce()
        })

        it('defaults to info when no logLevel is provided', () => {
            initLoggerFromEnv({})
            consoleSpy.log.mockClear()
            logger.debug('hidden')
            logger.info('shown')
            expect(consoleSpy.debug).not.toHaveBeenCalled()
            expect(consoleSpy.log).toHaveBeenCalledOnce()
        })

        it('defaults to info for invalid logLevel', () => {
            initLoggerFromEnv({ logLevel: 'bogus' })
            consoleSpy.log.mockClear()
            logger.debug('hidden')
            logger.info('shown')
            expect(consoleSpy.debug).not.toHaveBeenCalled()
            expect(consoleSpy.log).toHaveBeenCalledOnce()
        })
    })

    describe('OpenObserve batching', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fetchSpy: any

        beforeEach(() => {
            fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(null, { status: 200 })
            )
            initLoggerFromEnv({
                logLevel: 'debug',
                openObserveUrl: 'http://localhost:5080/api/default/test/_json',
                openObserveAuth: 'Basic dGVzdDp0ZXN0'
            })
            consoleSpy.log.mockClear()
        })

        it('buffers logs and flushes them as a JSON array', async () => {
            logger.info('msg1')
            logger.info('msg2')

            // Not flushed yet
            expect(fetchSpy).not.toHaveBeenCalled()

            await flush()

            expect(fetchSpy).toHaveBeenCalledOnce()
            const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
            expect(url).toBe('http://localhost:5080/api/default/test/_json')
            expect(opts.method).toBe('POST')
            expect(opts.headers).toMatchObject({
                'Content-Type': 'application/json',
                'Authorization': 'Basic dGVzdDp0ZXN0'
            })

            const body = JSON.parse(opts.body as string) as unknown[]
            expect(body).toHaveLength(2)
            expect((body[0] as Record<string, unknown>).message).toBe('msg1')
            expect((body[1] as Record<string, unknown>).message).toBe('msg2')
        })

        it('does not POST when buffer is empty', async () => {
            await flush()
            expect(fetchSpy).not.toHaveBeenCalled()
        })

        it('clears buffer after flush', async () => {
            logger.info('msg')
            await flush()
            expect(fetchSpy).toHaveBeenCalledOnce()

            // Second flush should not POST (buffer empty)
            await flush()
            expect(fetchSpy).toHaveBeenCalledOnce()
        })

        it('logs to console on POST failure without throwing', async () => {
            fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Internal Server Error' }))
            logger.info('msg')
            await flush()

            // Should log failure to console.error
            expect(consoleSpy.error).toHaveBeenCalledWith(
                expect.stringContaining('OpenObserve POST failed: 500')
            )
        })

        it('logs to console on fetch error without throwing', async () => {
            fetchSpy.mockRejectedValueOnce(new Error('network down'))
            logger.info('msg')
            await flush()

            expect(consoleSpy.error).toHaveBeenCalledWith(
                expect.stringContaining('network down')
            )
        })

        it('omits Authorization header when openObserveAuth is not set', async () => {
            _resetLogger()
            consoleSpy.log.mockClear()
            initLoggerFromEnv({
                logLevel: 'info',
                openObserveUrl: 'http://localhost:5080/api/default/test/_json'
            })
            consoleSpy.log.mockClear()
            logger.info('msg')
            await flush()

            const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
            const headers = opts.headers as Record<string, string>
            expect(headers['Authorization']).toBeUndefined()
        })
    })

    describe('shutdownLogger', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fetchSpy: any

        beforeEach(() => {
            fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(null, { status: 200 })
            )
        })

        it('flushes remaining buffer on shutdown', async () => {
            initLoggerFromEnv({
                logLevel: 'info',
                openObserveUrl: 'http://localhost:5080/api/default/test/_json'
            })

            logger.info('final message')
            await shutdownLogger()

            expect(fetchSpy).toHaveBeenCalledOnce()
            const body = JSON.parse(
                (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
            ) as unknown[]
            expect(body).toHaveLength(1)
        })

        it('works in console-only mode (no error)', async () => {
            initLoggerFromEnv({ logLevel: 'info' })
            consoleSpy.log.mockClear()
            logger.info('msg')
            await shutdownLogger()
            // Should not throw, fetch should not be called
            expect(fetchSpy).not.toHaveBeenCalled()
        })
    })

    describe('startup diagnostics', () => {
        it('logs initialisation with OpenObserve disabled', () => {
            initLoggerFromEnv({ logLevel: 'warn' })

            expect(consoleSpy.log).toHaveBeenCalledOnce()
            const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string)
            expect(parsed).toMatchObject({
                level: 'info',
                message: 'Logger initialised',
                logLevel: 'warn',
                openObserve: 'disabled',
                openObserveUrl: null
            })
        })

        it('logs initialisation with OpenObserve enabled', () => {
            initLoggerFromEnv({
                logLevel: 'info',
                openObserveUrl: 'http://localhost:5080/api/default/test/_json',
                openObserveAuth: 'Basic abc'
            })

            expect(consoleSpy.log).toHaveBeenCalledOnce()
            const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string)
            expect(parsed).toMatchObject({
                level: 'info',
                message: 'Logger initialised',
                logLevel: 'info',
                openObserve: 'enabled',
                openObserveUrl: 'http://localhost:5080/api/default/test/_json'
            })
        })

        it('treats empty OPENOBSERVE_URL as disabled', () => {
            initLoggerFromEnv({ openObserveUrl: '' })

            const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string)
            expect(parsed.openObserve).toBe('disabled')
        })
    })
})
