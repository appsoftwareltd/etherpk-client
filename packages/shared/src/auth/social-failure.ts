import { SESSION_ENDED_MESSAGE } from '../navigation/sign-in-path'

const PROVIDER_LABELS = { github: 'GitHub', google: 'Google' } as const

export type SocialProvider = keyof typeof PROVIDER_LABELS

/**
 * What a page says when Better Auth refuses to start a social sign-in or to link an account:
 * which provider, and the server's reason. On success the browser is already leaving for the
 * provider, so a refusal is the only outcome a page has to show.
 */
export function socialFailureMessage(
    action: 'continue with' | 'connect',
    provider: SocialProvider,
    error: { message?: string; status?: number } | null | undefined,
): string {
    if (error?.status === 401) return SESSION_ENDED_MESSAGE
    const reason = error?.message ? `: ${error.message}` : '. Try again.'
    return `Could not ${action} ${PROVIDER_LABELS[provider]}${reason}`
}
