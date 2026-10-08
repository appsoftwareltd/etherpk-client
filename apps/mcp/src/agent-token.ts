/**
 * How the Headless Client gets and gives up its agent token (ADR 0132), against the Sync Server's
 * own routes. Separate from the shared REST bridge (`sync-api.ts`), which always sends a token:
 * redeeming a setup code is the one call made before this computer holds any.
 *
 * - `redeemSetupCode`: `login --code` trades the one-time code for the agent token.
 * - `exchangeForAgentToken`: a standard token, pasted into `login` or left in the login file by
 *   an older version, is traded for an agent token; the Sync Server revokes the standard one.
 * - `revokeHeldToken`: `logout` revokes the token it is about to forget, so no token is left on
 *   the server that no machine holds.
 */

export class AgentTokenError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: string,
    ) {
        super(message)
        this.name = 'AgentTokenError'
    }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface Call {
    syncServer: string
    fetch?: Fetch
}

const OLDER_SERVER = 'This Sync Server runs an older version of EtherPK that cannot give agent tokens. Ask whoever runs it to update it, or log in with an access token from its Access tokens page.'

function base(syncServer: string): string {
    return syncServer.replace(/\/+$/, '')
}

/** The agent token from a 201, or the server's refusal as an AgentTokenError. */
async function tokenFrom(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as { token?: unknown; error?: { message?: string; code?: string } } | null
    if (response.ok && typeof body?.token === 'string') return body.token
    throw new AgentTokenError(body?.error?.message ?? `HTTP ${response.status}`, response.status, body?.error?.code)
}

/** Trade a one-time setup code for an agent token named `name` ("Agent on <hostname>"). */
export async function redeemSetupCode(call: Call & { code: string; name: string }): Promise<string> {
    const response = await (call.fetch ?? fetch)(`${base(call.syncServer)}/api/v1/sync/agent-tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupCode: call.code, name: call.name }),
    })
    // A 404 with no JSON body is a server that has no such route: one from before setup codes.
    if (response.status === 404 && !response.headers.get('content-type')?.includes('json')) throw new AgentTokenError(OLDER_SERVER, 404)
    return tokenFrom(response)
}

/**
 * Trade the standard token `token` for an agent token named `name`; the server revokes `token`.
 * Null on a server from before agent tokens, where the standard token simply goes on working.
 */
export async function exchangeForAgentToken(call: Call & { token: string; name: string }): Promise<string | null> {
    const response = await (call.fetch ?? fetch)(`${base(call.syncServer)}/api/v1/sync/agent-tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${call.token}` },
        body: JSON.stringify({ name: call.name }),
    })
    if (response.status === 404 && !response.headers.get('content-type')?.includes('json')) return null
    return tokenFrom(response)
}

/**
 * Revoke the token this computer holds. True once the server has revoked it; false when it could
 * not be reached or refused (already revoked, expired, or a server from before this route), which
 * a logout reports but does not stop for: the local copy is forgotten either way.
 */
export async function revokeHeldToken(call: Call & { token: string }): Promise<boolean> {
    try {
        const response = await (call.fetch ?? fetch)(`${base(call.syncServer)}/api/v1/sync/tokens/current`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${call.token}` },
        })
        return response.ok
    } catch {
        return false
    }
}
