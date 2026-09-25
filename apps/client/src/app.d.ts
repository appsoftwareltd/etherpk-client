// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
    namespace App {
        interface Locals {
            themePreference: import('@appsoftwareltd/etherpk-shared/theme').ThemePreference
            resolvedTheme: import('@appsoftwareltd/etherpk-shared/theme').ResolvedTheme
            settings: import('$lib/settings').ClientSettings
            managedSessionAvailable: boolean
        }
        interface PageState {
            /** Navigation History: the Visit this history entry lands on (ADR 0023). */
            etherpkVisit?: import('$lib/navigation').VisitState
            /**
             * Settings open on this entry, and the tab it is on (ADR 0023, 2026-09-20). `pushed`
             * says the workspace pushed the entry to open it, so closing is a Back; an entry
             * adopted from a deep link or reload closes by stripping the address in place.
             */
            etherpkSettings?: { tab: import('$lib/workspace/device-memory').SettingsTab; pushed: boolean }
        }
    }

    /**
     * The commit and instant this bundle was built, frozen in by the `define` in
     * vite.config.ts. hooks.server.ts stamps it into the top of every page source.
     */
    const __BUILD_INFO__: import('@appsoftwareltd/etherpk-shared/build-stamp').BuildInfo
}

export {}
