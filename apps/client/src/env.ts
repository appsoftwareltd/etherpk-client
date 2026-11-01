import { defineEnvVars } from '@sveltejs/kit/env'

/**
 * Every setting the Client reads at run time, for `$app/env/private` and `$app/env/public`.
 * `.env.example` says what each one does, and `env-example.test.ts` checks that every setting the
 * source reads is declared here.
 *
 * All of them are optional: an unset setting reads as `undefined`, as it did through
 * `$env/dynamic/*`, and the code that reads it supplies the default.
 */
const optional = { schema: (value: string | undefined) => value }
const optionalPublic = { ...optional, public: true }

export const variables = defineEnvVars({
    LOG_LEVEL: optional,
    OPENOBSERVE_URL: optional,
    OPENOBSERVE_AUTH: optional,

    // The managed sign-in (Corporate) and the Client's own session.
    CLIENT_PUBLIC_URL: optional,
    CLIENT_SESSION_SECRET: optional,
    CORPORATE_ISSUER: optional,
    MANAGED_OAUTH_CLIENT_ID: optional,
    MANAGED_SYNC_URL: optional,
    PUBLIC_MANAGED_SYNC_URL: optionalPublic,
    PUBLIC_CUSTOM_SYNC_URL: optionalPublic,

    // The Extension Directory and the registry its packages come from (ADR 0123).
    EXTENSION_DIRECTORY_URL: optional,
    EXTENSION_REGISTRY_URL: optional,
    EXTENSION_CACHE_DIR: optional,

    PUBLIC_DICTIONARY_URL: optionalPublic,
    PUBLIC_TERMS_URL: optionalPublic,
    PUBLIC_PRIVACY_URL: optionalPublic,

    // Read by the compiled-in maps extension (ADR 0121).
    PUBLIC_MAP_STYLE_URL: optionalPublic,
    PUBLIC_MAP_STYLE_URL_DARK: optionalPublic,
    PUBLIC_PLACE_SEARCH_URL: optionalPublic,
    PUBLIC_POSTCODES_URL: optionalPublic,
})
