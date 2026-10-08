/**
 * How the Headless Client's `login` is spelled wherever EtherPK prints it for a person to paste:
 * the Client's Agents tab and the Sync Server's Access tokens page. One place, so the two cannot
 * disagree with each other or with the docs.
 */

/** The npm package the commands invoke. */
export const HEADLESS_CLIENT_PACKAGE = '@appsoftwareltd/etherpk-mcp'

/**
 * The package spec the commands run: `version` pinned, or the bare name, which npm resolves to
 * its latest release. The Client, the Sync Server and the Headless Client of one release share a
 * version, so pinning to the Client's own keeps an agent on the Headless Client that was released
 * with the server the operator runs, whatever npm has published since.
 */
export function headlessClientPackage(version: string | null): string {
    return version ? `${HEADLESS_CLIENT_PACKAGE}@${version}` : HEADLESS_CLIENT_PACKAGE
}

/**
 * The one-time sign-in on the agent's machine. With a setup code (ADR 0132) the command is the
 * whole sign-in: `login` trades the code for an agent token and then asks for Device Approval.
 */
export function headlessClientLoginCommand(serverBaseUrl: string, headlessClient: string, setupCode?: string): string {
    const server = serverBaseUrl.replace(/\/$/, '')
    return `npx ${headlessClient} login --sync-server ${server}${setupCode ? ` --code ${setupCode}` : ''}`
}
