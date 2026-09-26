import { describe, expect, it } from 'vitest'
import { describeDevice } from './device-name'

describe('describeDevice', () => {
    it.each([
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Chrome on macOS'],
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'Edge on Windows'],
        ['Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', 'Firefox on Linux'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
        ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
        ['Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1', 'Chrome on iPad'],
    ])('names %s', (userAgent, name) => {
        expect(describeDevice(userAgent)).toBe(name)
    })

    it('falls back when there is no user agent', () => {
        expect(describeDevice(null)).toBe('Unknown device')
        expect(describeDevice('curl/8.9.1')).toBe('Unknown device')
    })
})
