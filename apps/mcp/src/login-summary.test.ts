import { describe, expect, it } from 'vitest'

import { agentSetupLine, loginSummary, SWITCHING_TO_RECOVERY_CODE } from './login-summary'

/**
 * What `login` prints once the login is saved. A first user read "Revoked the token…" and
 * "Approval cancelled…" as failures of a login that had worked, so the wording is pinned here.
 */

const base = {
    syncServer: 'https://sync.example.test',
    configPath: '/home/someone/.config/etherpk/mcp.json',
    keptIn: '/home/someone/.config/etherpk/mcp.json',
    exchangedAccessToken: false,
    replacedEarlierLogin: false,
    otherServers: [],
    stoppedHosts: 0,
}

describe('loginSummary', () => {
    it('opens with the outcome: logged in, and what this device can now do', () => {
        const [first] = loginSummary(base)
        expect(first).toBe('Logged in. This device can now serve your synced graphs on https://sync.example.test to agents.')
    })

    it('words a replaced earlier login as routine, after the outcome', () => {
        const paragraphs = loginSummary({ ...base, replacedEarlierLogin: true })
        expect(paragraphs[0]).toMatch(/^Logged in\./)
        expect(paragraphs[1]).toBe("Replaced this device's earlier login to https://sync.example.test. Its old token no longer works.")
        expect(paragraphs.join('\n')).not.toMatch(/^Revoked/m)
    })

    it('says nothing of an earlier login when there was none', () => {
        expect(loginSummary(base).join('\n')).not.toContain('earlier login')
    })

    it('says where the keys are kept, in the file or the keychain', () => {
        expect(loginSummary(base)[1]).toMatch(/^Encryption Keys unlocked and kept in \/home\/someone\/\.config\/etherpk\/mcp\.json \(owner-only\)\./)
        const keychain = loginSummary({ ...base, keptIn: 'the macOS Keychain' })[1]
        expect(keychain).toMatch(/^Encryption Keys unlocked and kept in the macOS Keychain\./)
        expect(keychain).toContain('/home/someone/.config/etherpk/mcp.json names only the server')
    })

    it('names the other logins and the stopped background processes', () => {
        const paragraphs = loginSummary({ ...base, otherServers: ['https://other.example.test'], stoppedHosts: 2 })
        expect(paragraphs.join('\n')).toContain('Also logged in to https://other.example.test')
        expect(paragraphs.join('\n')).toContain('Stopped the background process of 2 graphs')
    })
})

describe('agentSetupLine', () => {
    it("points at the Agents tab of the Client the Sync Server names", () => {
        expect(agentSetupLine('https://app.example.test')).toBe('Full instructions for setting up agents: https://app.example.test/graphs?tab=agents')
    })

    it('keeps a self-hosted Client at its own origin', () => {
        expect(agentSetupLine('https://notes.example.test:8443/')).toBe('Full instructions for setting up agents: https://notes.example.test:8443/graphs?tab=agents')
    })

    it('prints nothing when the Sync Server names no Client', () => {
        expect(agentSetupLine(null)).toBeNull()
    })
})

describe('switching to the Recovery Code', () => {
    it("reads as the person's choice, not a failure", () => {
        expect(SWITCHING_TO_RECOVERY_CODE).toBe('Unlocking with your Recovery Code instead.')
    })
})
