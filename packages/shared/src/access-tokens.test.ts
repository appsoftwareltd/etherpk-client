import { describe, expect, it } from 'vitest'

import {
    AGENT_SETUP_CODE_PREFIX,
    AGENT_TOKEN_PREFIX,
    STANDARD_TOKEN_PREFIX,
    accessTokenKind,
    looksLikeAgentSetupCode,
} from './access-tokens'

const secret = 'A'.repeat(43)

describe('access token formats', () => {
    it('tells a standard token from an agent token by its prefix', () => {
        expect(accessTokenKind(STANDARD_TOKEN_PREFIX + secret)).toBe('standard')
        expect(accessTokenKind(AGENT_TOKEN_PREFIX + secret)).toBe('agent')
    })

    it('recognises neither a short token, a setup code nor some other string', () => {
        expect(accessTokenKind(AGENT_TOKEN_PREFIX + 'short')).toBeNull()
        expect(accessTokenKind(AGENT_SETUP_CODE_PREFIX + secret)).toBeNull()
        expect(accessTokenKind('')).toBeNull()
        expect(accessTokenKind('Bearer ' + STANDARD_TOKEN_PREFIX + secret)).toBeNull()
    })

    it('recognises a setup code, and only a setup code', () => {
        expect(looksLikeAgentSetupCode(AGENT_SETUP_CODE_PREFIX + secret)).toBe(true)
        expect(looksLikeAgentSetupCode(` ${AGENT_SETUP_CODE_PREFIX + secret} `)).toBe(false)
        expect(looksLikeAgentSetupCode(AGENT_TOKEN_PREFIX + secret)).toBe(false)
        expect(looksLikeAgentSetupCode(AGENT_SETUP_CODE_PREFIX + 'short')).toBe(false)
    })
})
