import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createPersonSettings } from '#lib/person-settings/person-settings.js'

import { createUsageStatistics } from './usage-statistics'

/**
 * Whatever order a person turns usage statistics on and off in, goes in and out of the demo and uses
 * features, an event reaches the collector only if it could be counted when it happened and the
 * queue could be sent when it was. `USAGE_FUZZ_RUNS` sets the run count.
 */

const RUNS = Number(process.env.USAGE_FUZZ_RUNS ?? 300)

type Step = 'use' | 'off' | 'on' | 'enter-demo' | 'leave-demo' | 'signal' | 'no-signal' | 'send'
const step = fc.constantFrom<Step>('use', 'off', 'on', 'enter-demo', 'leave-demo', 'signal', 'no-signal', 'send')

const COMMANDS = ['command.tasks.open', 'command.search.open']

describe('usage statistics, in any order of events', () => {
    it('sends what was used while it was on, and only while it is on', () => {
        fc.assert(
            fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
                const held: Record<string, string> = {}
                const storage = {
                    getItem: (key: string) => held[key] ?? null,
                    setItem: (key: string, value: string) => void (held[key] = value),
                } as unknown as Storage
                let demo = false
                let signal = false
                let off = false
                const sent: string[] = []
                let sentWhileOff = 0
                const statistics = createUsageStatistics({
                    target: { url: 'https://stats.example.com/api/batch', websiteId: '0b5f6c1e-3a52-4c1f-9a44-1c2d3e4f5a6b' },
                    settings: createPersonSettings(() => storage),
                    privacySignal: () => signal,
                    paused: () => demo,
                    now: () => 0,
                    context: () => ({ version: '1.2.3', install: 'browser', deployment: 'self-hosted', layout: 'desktop', theme: 'light' }),
                    send: (_url, body) => {
                        // Noted, not asserted here: the queue swallows what a send throws.
                        if (off || signal || demo) sentWhileOff++
                        sent.push(...(JSON.parse(body) as { payload: { name: string } }[]).map((event) => event.payload.name))
                    },
                })
                statistics.start()

                // What a page owes the collector, read straight from the rule.
                let queued = ['app_opened']
                const expected: string[] = []
                let uses = 0
                for (const next of steps) {
                    if (next === 'use') {
                        const name = COMMANDS[uses++ % COMMANDS.length]
                        statistics.record({ name })
                        if (!off && !signal && !demo) queued.push(name)
                    } else if (next === 'off' || next === 'on') {
                        off = next === 'off'
                        statistics.setEnabled(!off)
                    } else if (next === 'enter-demo' || next === 'leave-demo') demo = next === 'enter-demo'
                    else if (next === 'signal' || next === 'no-signal') signal = next === 'signal'
                    else {
                        statistics.flush()
                        if (!off && !signal && !demo) expected.push(...queued)
                        queued = []
                    }
                }
                expect(sent).toEqual(expected)
                expect(sentWhileOff).toBe(0)
            }),
            { seed: 20261124, numRuns: RUNS },
        )
    })
})
