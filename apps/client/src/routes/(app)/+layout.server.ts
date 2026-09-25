import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = async ({ locals }) => {
    return {
        themePreference: locals.themePreference,
        resolvedTheme: locals.resolvedTheme,
        settings: locals.settings,
    }
}
