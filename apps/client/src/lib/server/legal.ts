import { managedLegalLinks, parseLegalPageUrl, type LegalLinks } from '@appsoftwareltd/etherpk-shared/legal'
import { parseOptionalManagedClientAuthConfig } from './auth/config'

type Environment = Record<string, string | undefined>

/**
 * The Client's Terms, Privacy and Contact links. A managed Client (managed sign-in configured)
 * links EtherPK's pages on Corporate; a self-hosted one links the operator's pages from
 * `PUBLIC_TERMS_URL` and `PUBLIC_PRIVACY_URL`, or none. The Client has no contact page of its
 * own.
 */
export function clientLegalLinks(privateEnvironment: Environment, publicEnvironment: Environment): LegalLinks {
    const managed = parseOptionalManagedClientAuthConfig(privateEnvironment)
    if (managed) return managedLegalLinks(managed.issuer)
    return {
        termsUrl: parseLegalPageUrl(publicEnvironment.PUBLIC_TERMS_URL, 'PUBLIC_TERMS_URL'),
        privacyUrl: parseLegalPageUrl(publicEnvironment.PUBLIC_PRIVACY_URL, 'PUBLIC_PRIVACY_URL'),
        contactUrl: null,
    }
}
