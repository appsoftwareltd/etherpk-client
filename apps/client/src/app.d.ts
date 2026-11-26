// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
    namespace App {
        interface Locals {
            themePreference: import('@appsoftwareltd/etherpk-shared/theme').ThemePreference
            resolvedTheme: import('@appsoftwareltd/etherpk-shared/theme').ResolvedTheme
            settings: import('#lib/settings.js').ClientSettings
            managedSessionAvailable: boolean
            /**
             * Set when the silent check skipped this load only because one missed recently: the
             * page asks the account site whether the browser has signed in there since.
             */
            signedInElsewhereCheck: import('@appsoftwareltd/etherpk-shared').SignedInElsewhereCheck | null
        }
        interface PageState {
            /** Navigation History: the Visit this history entry lands on (ADR 0023). */
            etherpkVisit?: import('#lib/navigation/index.js').VisitState
            /**
             * Settings open on this entry, and the tab it is on (ADR 0023, 2026-09-20). `pushed`
             * says the workspace pushed the entry to open it, so closing is a Back; an entry
             * adopted from a deep link or reload closes by stripping the address in place.
             */
            etherpkSettings?: { tab: import('#lib/workspace/device-memory.js').SettingsTab; pushed: boolean }
            /**
             * The [[Plain Folder]] this entry is in, by id. An address cannot say which of two
             * folders with one name is meant (ADR 0194).
             */
            etherpkPlainFolder?: string
            /**
             * The graph this entry is in, by id (chosen-graph.ts). An address cannot say which of
             * two folder graphs kept in folders with one name is meant (ADR 0192).
             */
            etherpkGraph?: string
        }
    }

    /**
     * The commit and instant this bundle was built, frozen in by the `define` in
     * vite.config.ts. hooks.server.ts stamps it into the top of every page source.
     */
    const __BUILD_INFO__: import('@appsoftwareltd/etherpk-shared/build-stamp').BuildInfo

    /** This Client's release (`apps/client/package.json`), frozen in by vite.config.ts. */
    const __RELEASE_VERSION__: string

    /**
     * What an Installed Build was made with, frozen in by vite.config.ts. Null in every other build.
     * Only for what the captured page has to carry: ask `isNativeApp()` at run time.
     */
    const __INSTALLED_BUILD__: { accountIssuer: string | null; webClientUrl: string | null } | null
}

// `aria-description` (WAI-ARIA 1.3) is read by browsers and screen readers, but Svelte's element
// types predate it. A button whose tooltip says more than its name gives a screen reader the same
// words with it (surface/tooltip.ts, scripts/repository-rules.test.mjs).
declare module 'svelte/elements' {
    interface AriaAttributes {
        'aria-description'?: string | undefined | null
    }
}

export {}
