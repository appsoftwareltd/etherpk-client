import { managedLegalLinks, parseLegalPageUrl, type LegalLinks } from '@appsoftwareltd/etherpk-shared/legal'
import { parseOptionalManagedClientAuthConfig } from './auth/config'

type Environment = Record<string, string | undefined>

/**
 * The Client's Terms, Privacy and Contact links. A managed Client links EtherPK's pages on the account
 * site; a self-hosted one links the operator's pages from `PUBLIC_TERMS_URL` and `PUBLIC_PRIVACY_URL`,
 * or none. The Client has no contact page of its own.
 *
 * `issuer` is the account site, where the caller knows it another way (a Native App's build). By
 * default it is the one managed sign-in is configured with.
 */
export function clientLegalLinks(
    privateEnvironment: Environment,
    publicEnvironment: Environment,
    issuer: string | null = parseOptionalManagedClientAuthConfig(privateEnvironment)?.issuer ?? null,
): LegalLinks {
    if (issuer) return managedLegalLinks(issuer)
    return {
        termsUrl: parseLegalPageUrl(publicEnvironment.PUBLIC_TERMS_URL, 'PUBLIC_TERMS_URL'),
        privacyUrl: parseLegalPageUrl(publicEnvironment.PUBLIC_PRIVACY_URL, 'PUBLIC_PRIVACY_URL'),
        contactUrl: null,
    }
}
