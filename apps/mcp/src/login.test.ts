import { describe, expect, it } from 'vitest'

import { encryptVault, generateIdentityKeyPair, toBase64Url } from '$lib/crypto'
import { deriveVaultWrapKey, generateRecoveryCode } from '$lib/crypto/recovery-code'
import {
    answerDeviceApproval,
    approveDevice,
    readApproverExchange,
    type ApproverSession,
    type PendingDeviceApproval,
} from '$lib/sync/device-approval'
import type { SyncApi } from '$lib/sync/sync-api'

import {
    approvalWaitControls,
    ApprovalAbandoned,
    sleepUnlessAborted,
    unlockByDeviceApproval,
    unlockByRecoveryCode,
} from './login'

/**
 * Both unlock routes against a fake Sync Server holding a real vault: what the CLI prints,
 * what it caches, and that the Recovery Code itself is never what comes back.
 */
async function account() {
    const identity = generateIdentityKeyPair()
    const code = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(code)
    const encrypted = await encryptVault(
        { identityPrivateKey: identity.privateKey, identityPublicKey: identity.publicKey, keyrings: [] },
        wrapKey,
    )
    return { code, vaultKey: encrypted.vaultKey, envelope: toBase64Url(encrypted.envelope) }
}

describe('unlockByRecoveryCode', () => {
    it('derives the wrap key from the code and returns the vault key, not the wrap key', async () => {
        const a = await account()
        const api = { getVault: async () => ({ vault: a.envelope, version: 1 }) } as unknown as SyncApi
        const key = await unlockByRecoveryCode(api, a.code.toLowerCase().replaceAll('-', ' '))
        expect(toBase64Url(key)).toBe(toBase64Url(a.vaultKey))
    })

    it('rejects a wrong code and an account with no vault', async () => {
        const a = await account()
        const api = { getVault: async () => ({ vault: a.envelope, version: 1 }) } as unknown as SyncApi
        await expect(unlockByRecoveryCode(api, generateRecoveryCode())).rejects.toThrow('does not open this account')
        const empty = { getVault: async () => null } as unknown as SyncApi
        await expect(unlockByRecoveryCode(empty, a.code)).rejects.toThrow('no Encryption Keys')
    })
})

/**
 * A Sync Server holding one approval request (ADR 0125), and the unlocked EtherPK tab that answers
 * and approves it: what the terminal flow talks to, step by step.
 */
function approvalServer(envelope: string) {
    let row: { id: string; commitment: string; status: string; approverPublicKey?: string; requesterPublicKey?: string; reply?: string } | null =
        null
    const api = {
        getVault: async () => ({ vault: envelope, version: 1, principalId: 'account-1' }),
        createDeviceApproval: async (commitment: string) => {
            row = { id: 'appr-1', commitment, status: 'pending' }
            return { id: 'appr-1' }
        },
        listDeviceApprovals: async () => (row && ['pending', 'answered', 'revealed'].includes(row.status) ? [{ ...row, createdAt: '' }] : []),
        respondToDeviceApproval: async (_id: string, approverPublicKey: string) => {
            row!.approverPublicKey = approverPublicKey
            row!.status = 'answered'
            return { ok: true as const }
        },
        revealDeviceApproval: async (_id: string, requesterPublicKey: string) => {
            row!.requesterPublicKey = requesterPublicKey
            row!.status = 'revealed'
            return { ok: true as const }
        },
        pollDeviceApproval: async () => {
            if (row!.status === 'sealed') {
                const reply = row!.reply
                row!.status = 'claimed'
                return { status: 'sealed', approverPublicKey: row!.approverPublicKey, sealedVaultKey: reply }
            }
            return { status: row!.status, ...(row!.approverPublicKey ? { approverPublicKey: row!.approverPublicKey } : {}) }
        },
        sealDeviceApproval: async (_id: string, reply: string) => {
            row!.reply = reply
            row!.status = 'sealed'
            return { ok: true as const }
        },
        cancelDeviceApproval: async () => ({ ok: true as const }),
    } as unknown as SyncApi
    let session: ApproverSession | null = null
    /** The tab: answer the request, then once the terminal has revealed, read the code and approve. */
    const tab = {
        async answer() {
            const [pending] = (await api.listDeviceApprovals()) as PendingDeviceApproval[]
            const answered = await answerDeviceApproval(api, pending)
            if (answered === 'taken') throw new Error('unreachable')
            session = answered
        },
        async code(): Promise<string | null> {
            const [listed] = (await api.listDeviceApprovals()) as PendingDeviceApproval[]
            return (await readApproverExchange(session!, listed))?.sas ?? null
        },
        async approve(vaultKey: Uint8Array) {
            await approveDevice(api, session!, vaultKey)
        },
    }
    return { api, tab }
}

describe('unlockByDeviceApproval', () => {
    it('prints the code the tab shows, and returns the vault key once the tab approved and y was pressed', async () => {
        const a = await account()
        const { api, tab } = approvalServer(a.envelope)
        const said: string[] = []
        let pressedY = false
        let polls = 0
        const io = {
            say: (line: string) => said.push(line),
            codesMatch: () => pressedY,
            sleep: async () => {
                polls++
                if (polls === 1) await tab.answer()
                if (polls === 2) {
                    // The terminal revealed and printed its code on the previous poll.
                    const shown = await tab.code()
                    expect(shown).not.toBeNull()
                    expect(said.join('\n')).toContain(shown!)
                    await tab.approve(a.vaultKey)
                }
                if (polls === 4) pressedY = true
            },
        }
        const key = await unlockByDeviceApproval(api, { ...io, clientUrl: 'https://app.example.test' })
        expect(toBase64Url(key)).toBe(toBase64Url(a.vaultKey))
        // The key was held until y, not used the moment the tab approved.
        expect(polls).toBe(4)
        expect(said.join('\n')).toContain('EtherPK approved this device. Press y if it showed the same code.')
        // The instruction names the Client, not the Server, and says a tab of any page will do.
        expect(said.join('\n')).toContain('open EtherPK at https://app.example.test')
        expect(said.join('\n')).toMatch(/any page/)
    })

    it('shows no code until a tab answers', async () => {
        const a = await account()
        const { api } = approvalServer(a.envelope)
        const said: string[] = []
        const abort = new AbortController()
        let polls = 0
        const io = {
            say: (line: string) => said.push(line),
            codesMatch: () => false,
            sleep: async () => {
                if (++polls === 3) abort.abort()
            },
            signal: abort.signal,
        }
        await expect(unlockByDeviceApproval(api, io)).rejects.toBeInstanceOf(ApprovalAbandoned)
        expect(said.join('\n')).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/)
    })

    it('says "open EtherPK in a browser" when the Server did not declare a Client', async () => {
        const said: string[] = []
        const api = {
            createDeviceApproval: async () => ({ id: 'appr-3' }),
            pollDeviceApproval: async () => ({ status: 'rejected' }),
        } as unknown as SyncApi
        await expect(unlockByDeviceApproval(api, { say: (l) => said.push(l), sleep: async () => {}, codesMatch: () => false })).rejects.toThrow('rejected')
        expect(said.join('\n')).toContain('open EtherPK in a browser')
    })

    it('abandons the wait when asked, cancelling the approval server-side', async () => {
        const abort = new AbortController()
        let cancelled: string | null = null
        const api = {
            createDeviceApproval: async () => ({ id: 'appr-4' }),
            pollDeviceApproval: async () => ({ status: 'pending' }),
            cancelDeviceApproval: async (id: string) => {
                cancelled = id
                return { ok: true as const }
            },
        } as unknown as SyncApi
        const io = {
            say: () => {},
            codesMatch: () => false,
            sleep: async () => {
                abort.abort() // the user pressed r during the wait
            },
            signal: abort.signal,
        }
        await expect(unlockByDeviceApproval(api, io)).rejects.toBeInstanceOf(ApprovalAbandoned)
        expect(cancelled).toBe('appr-4')
    })

    it('reports a rejection in words', async () => {
        const api = {
            createDeviceApproval: async () => ({ id: 'appr-2' }),
            pollDeviceApproval: async () => ({ status: 'rejected' }),
        } as unknown as SyncApi
        await expect(unlockByDeviceApproval(api, { say: () => {}, sleep: async () => {}, codesMatch: () => false })).rejects.toThrow('rejected')
    })
})

describe('ending the approval wait early', () => {
    it('r switches to the Recovery Code: the wait aborts, and nothing exits', () => {
        const controls = approvalWaitControls()
        controls.onKey('r')
        expect(controls.signal.aborted).toBe(true)
        expect(controls.exitCode).toBeNull()
    })

    it('Ctrl-C quits, but only after the wait has aborted and cancelled its approval', () => {
        const controls = approvalWaitControls()
        controls.onKey('\u0003')
        expect(controls.signal.aborted).toBe(true)
        expect(controls.exitCode).toBe(130)
    })

    it.each([
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
    ] as const)('%s quits with the shell exit code %s', (name, code) => {
        const controls = approvalWaitControls()
        controls.onSignal(name)
        expect(controls.signal.aborted).toBe(true)
        expect(controls.exitCode).toBe(code)
    })

    it('ignores other keys', () => {
        const controls = approvalWaitControls()
        controls.onKey('x')
        expect(controls.signal.aborted).toBe(false)
        expect(controls.codesMatch).toBe(false)
    })

    it('y confirms the codes match without ending the wait', () => {
        const controls = approvalWaitControls()
        controls.onKey('y')
        expect(controls.codesMatch).toBe(true)
        expect(controls.signal.aborted).toBe(false)
    })

    it('n says the codes differ: the wait aborts, records the mismatch, and nothing exits', () => {
        const controls = approvalWaitControls()
        controls.onKey('n')
        expect(controls.signal.aborted).toBe(true)
        expect(controls.mismatched).toBe(true)
        expect(controls.exitCode).toBeNull()
    })

    it('piped input that ends before a y ends the wait, since nothing can confirm now', () => {
        const controls = approvalWaitControls()
        controls.onInputClosed()
        expect(controls.signal.aborted).toBe(true)
        expect(controls.inputClosed).toBe(true)
    })

    it('piped input that ends after a y leaves the wait running', () => {
        const controls = approvalWaitControls()
        controls.onKey('y\n')
        controls.onInputClosed()
        expect(controls.signal.aborted).toBe(false)
        expect(controls.codesMatch).toBe(true)
    })

    it('stops sleeping as soon as the wait aborts, so a quit does not wait out the poll interval', async () => {
        const abort = new AbortController()
        const started = Date.now()
        const sleeping = sleepUnlessAborted(60_000, abort.signal)
        abort.abort()
        await sleeping
        expect(Date.now() - started).toBeLessThan(1_000)
    })
})
