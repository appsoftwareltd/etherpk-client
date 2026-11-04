import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { chromiumOnThisMachine, warmChromium, WARM_UP_TIMEOUT } from './chromium-fixture'
import { browserLogErrors, chromiumStartFailure } from './diagrams'

// `diagrams status` starts the browser, because a file that exists can still fail to run: a missing
// library, or a library path inherited from whatever started this process.

describe('whether the browser a publish would use starts', () => {
    let scratch: string
    const chromium = chromiumOnThisMachine()

    beforeAll(async () => {
        scratch = await mkdtemp(join(tmpdir(), 'etherpk-diagrams-'))
        await warmChromium(chromium)
    }, WARM_UP_TIMEOUT)
    afterAll(async () => {
        await rm(scratch, { recursive: true, force: true })
    })

    it.skipIf(process.platform === 'win32')('reports what an executable that cannot start said', async () => {
        const executable = join(scratch, 'broken-browser')
        await writeFile(executable, '#!/bin/sh\necho "libgarden.so: cannot open shared object file" >&2\nexit 1\n')
        await chmod(executable, 0o755)
        const failure = await chromiumStartFailure({ ETHERPK_CHROMIUM: executable })
        expect(failure).toBe('libgarden.so: cannot open shared object file')
    }, WARM_UP_TIMEOUT)

    it('has nothing to report when there is no executable to start', async () => {
        expect(await chromiumStartFailure({ ETHERPK_CHROMIUM: join(scratch, 'no-such-browser') })).toBeNull()
    })

    it.skipIf(!chromium)('has nothing to report for a browser that starts', async () => {
        expect(await chromiumStartFailure({ ...process.env, ETHERPK_CHROMIUM: chromium! })).toBeNull()
    }, WARM_UP_TIMEOUT)
})

describe('the lines a failed launch is reported by', () => {
    it('are what the browser wrote to stderr, each once, without the launcher’s prefix', () => {
        const message = [
            'browserType.launch: Target page, context or browser has been closed',
            'Browser logs:',
            '',
            '<launching> /opt/browser --headless',
            '<launched> pid=41',
            '[pid=41][err] /opt/browser: libgarden.so: not found',
            '[pid=41][err] /opt/browser: libgarden.so: not found',
            'Call log:',
            '\u001b[2m  - [pid=41][err] /opt/browser: libgarden.so: not found\u001b[22m',
            '\u001b[2m  - [pid=41] <kill>\u001b[22m',
        ].join('\n')
        expect(browserLogErrors(message)).toBe('/opt/browser: libgarden.so: not found')
    })

    it('are the message’s first line when the browser wrote nothing', () => {
        expect(browserLogErrors('browserType.launch: Timeout 180000ms exceeded.\nCall log:\n  - <launching>')).toBe('browserType.launch: Timeout 180000ms exceeded.')
    })
})
