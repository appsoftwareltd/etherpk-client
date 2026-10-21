import { describe, expect, it } from 'vitest'

import { installOutcomeResponse } from './install-outcome'

describe('installOutcomeResponse', () => {
    it('answers a known outcome with nothing, so only the request log line remains', () => {
        for (const outcome of ['accepted', 'dismissed', 'installed']) {
            const response = installOutcomeResponse(new URL(`https://app.test/api/install?outcome=${outcome}`))
            expect(response.status).toBe(204)
            expect(response.headers.get('cache-control')).toBe('no-store')
        }
    })

    it('refuses anything else, so the count holds only the three outcomes', () => {
        expect(installOutcomeResponse(new URL('https://app.test/api/install')).status).toBe(400)
        expect(installOutcomeResponse(new URL('https://app.test/api/install?outcome=Garden')).status).toBe(400)
    })
})
