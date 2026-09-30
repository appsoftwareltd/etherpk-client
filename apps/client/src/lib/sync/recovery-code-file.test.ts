import { describe, expect, it } from 'vitest'
import { recoveryCodeFileName, recoveryCodeFileText } from './recovery-code-file'

describe('the saved Recovery Code names its Sync Server', () => {
    it('puts the server in the file name, so two codes never overwrite or pass for each other', () => {
        expect(recoveryCodeFileName('https://sync.etherpk.com')).toBe('etherpk-recovery-code-sync.etherpk.com.txt')
        expect(recoveryCodeFileName('http://localhost:5173')).toBe('etherpk-recovery-code-localhost-5173.txt')
        expect(recoveryCodeFileName('https://Team.Example.org')).toBe('etherpk-recovery-code-team.example.org.txt')
    })

    it('says in the file which server and account the code unlocks, and that other codes stay valid', () => {
        const text = recoveryCodeFileText({
            code: 'EPK1-AAAAA-BBBBB',
            serverOrigin: 'https://sync.etherpk.com',
            account: 'you@example.com',
        })

        expect(text).toContain('EPK1-AAAAA-BBBBB')
        expect(text).toContain('Sync Server: https://sync.etherpk.com')
        expect(text).toContain('Account: you@example.com')
        expect(text).toContain('only on sync.etherpk.com')
        expect(text).toContain('Keep each one')
    })

    it('leaves the account line out when the account has no address to name', () => {
        const text = recoveryCodeFileText({ code: 'EPK1-AAAAA', serverOrigin: 'https://team.example.org', account: null })
        expect(text).not.toContain('Account:')
        expect(text).toContain('Sync Server: https://team.example.org')
    })
})
