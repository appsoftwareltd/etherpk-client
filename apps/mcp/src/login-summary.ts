/**
 * What `login` prints once the login is saved, as paragraphs the caller separates with blank
 * lines. The outcome comes first, so a person who worked through Device Approval or typed a
 * Recovery Code sees at once that it worked, and the housekeeping after it reads as routine.
 */

export interface LoginOutcome {
    syncServer: string
    /** The config file. */
    configPath: string
    /** Where `saveLogin` put the token and keys: the config file, or the keychain's name. */
    keptIn: string
    /** An access token was given and swapped for an Agent Token, which revoked it. */
    exchangedAccessToken: boolean
    /** This computer held a login to the same server, and its token was revoked. */
    replacedEarlierLogin: boolean
    /** The other servers this computer is logged in to. */
    otherServers: readonly string[]
    /** Background processes stopped because they held the login this one replaced. */
    stoppedHosts: number
}

export function loginSummary(outcome: LoginOutcome): string[] {
    const { syncServer, configPath, keptIn } = outcome
    const paragraphs = [`Logged in. This device can now serve your synced graphs on ${syncServer} to agents.`]
    if (outcome.exchangedAccessToken) {
        paragraphs.push(
            `The access token you gave has been revoked. This device now holds an Agent Token, limited to the routes an agent needs. If you used that access token anywhere else, create a new one at ${syncServer}/account/tokens.`,
        )
    }
    if (outcome.replacedEarlierLogin) {
        paragraphs.push(`Replaced this device's earlier login to ${syncServer}. Its old token no longer works.`)
    }
    paragraphs.push(
        keptIn === configPath
            ? `Encryption Keys unlocked and kept in ${configPath} (owner-only). Anyone who can read your files on this device can read this account, as with a signed-in browser. Never let an agent read, print or search that file.`
            : `Encryption Keys unlocked and kept in ${keptIn}. ${configPath} names only the server. A program you run can still ask ${keptIn} for them, so run only agents you trust with this account.`,
    )
    if (outcome.otherServers.length > 0) {
        paragraphs.push(`Also logged in to ${outcome.otherServers.join(', ')}, so commands need --sync-server <url> to say which server they mean.`)
    }
    if (outcome.stoppedHosts > 0) {
        const graphs = outcome.stoppedHosts === 1 ? 'one graph' : `${outcome.stoppedHosts} graphs`
        paragraphs.push(`Stopped the background process of ${graphs} served with the previous login. Agents start a new one with this login on their next call.`)
    }
    return paragraphs
}

/**
 * The last line of `login`: where the Client explains the rest of agent setup. Built from the
 * Client the Sync Server declares, since both can be self-hosted; null when it declares none.
 */
export function agentSetupLine(clientUrl: string | null): string | null {
    if (!clientUrl) return null
    return `Full instructions for setting up agents: ${new URL('/graphs?tab=agents', clientUrl).href}`
}

/** Printed when the person presses r during Device Approval: their choice, not a failure. */
export const SWITCHING_TO_RECOVERY_CODE = 'Unlocking with your Recovery Code instead.'
