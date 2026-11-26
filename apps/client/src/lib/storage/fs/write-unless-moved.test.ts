import { describe, expect, it } from 'vitest'

import { MOST_WRITE_TRIES, untilWritten } from './write-unless-moved'

describe('untilWritten', () => {
    it('answers with the first try that answers', async () => {
        let tries = 0
        expect(await untilWritten(async () => (++tries === 3 ? 'saved' : undefined))).toBe('saved')
        expect(tries).toBe(3)
    })

    it('fails as a file another program was using once the tries are spent', async () => {
        let tries = 0
        await expect(untilWritten(async () => { tries++; return undefined })).rejects.toMatchObject({ name: 'InvalidStateError' })
        expect(tries).toBe(MOST_WRITE_TRIES)
    })

    it('passes a null answer back, which is a save that stopped', async () => {
        expect(await untilWritten(async () => null)).toBe(null)
    })
})
