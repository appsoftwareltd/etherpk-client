import { describe, expect, it, vi } from 'vitest'
import { queueHistoryWrite } from './history-writes'

describe('queueHistoryWrite', () => {
    it('starts each write only after the one queued before it has finished', async () => {
        const steps: string[] = []
        let address = '/g/garden'
        const slowWrite = (to: string) => async () => {
            steps.push(`start ${to} from ${address}`)
            await new Promise((resolve) => setTimeout(resolve, 5))
            address = to
            steps.push(`end ${to}`)
        }

        void queueHistoryWrite(slowWrite('/g/garden/d/Kitchen'))
        await queueHistoryWrite(() => slowWrite(`${address}?settings=general`)())

        expect(steps).toEqual([
            'start /g/garden/d/Kitchen from /g/garden',
            'end /g/garden/d/Kitchen',
            'start /g/garden/d/Kitchen?settings=general from /g/garden/d/Kitchen',
            'end /g/garden/d/Kitchen?settings=general',
        ])
    })

    it('goes on to the next write after one fails, and rejects the failed one to its caller', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const failed = queueHistoryWrite(() => Promise.reject(new Error('no route')))
        const next = vi.fn()
        await queueHistoryWrite(next)

        await expect(failed).rejects.toThrow('no route')
        expect(next).toHaveBeenCalledOnce()
        warn.mockRestore()
    })
})
