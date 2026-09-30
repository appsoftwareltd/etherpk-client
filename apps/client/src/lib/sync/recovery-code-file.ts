/**
 * What a saved Recovery Code says about itself. Each Sync Server has its own account, vault and
 * Recovery Code (ADR 0111), so a device connected to two servers produces two codes. When both
 * downloaded as `etherpk-recovery-code.txt` and neither named its server, the second looked like
 * a replacement for the first, and throwing the first away would lock that server's graphs for
 * good once every device was lost. So the file name and the text both name the server.
 */
import { serverHost } from './sync-connections'

/** `etherpk-recovery-code-sync.etherpk.com.txt`: the host, reduced to characters every filesystem keeps. */
export function recoveryCodeFileName(serverOrigin: string): string {
    const host = serverHost(serverOrigin).toLowerCase().replace(/[^a-z0-9.-]+/g, '-')
    return `etherpk-recovery-code-${host}.txt`
}

export function recoveryCodeFileText(saved: { code: string; serverOrigin: string; account: string | null }): string {
    const host = serverHost(saved.serverOrigin)
    return [
        'EtherPK Recovery Code',
        '',
        `Sync Server: ${saved.serverOrigin}`,
        ...(saved.account ? [`Account: ${saved.account}`] : []),
        '',
        saved.code,
        '',
        `This code unlocks your encryption keys only on ${host}. A code for another Sync Server does not replace it and cannot stand in for it. Keep each one.`,
        '',
        'Keep this safe. It is the only way to restore access to your encrypted notes on this server if you lose every signed-in device.',
        '',
    ].join('\n')
}
