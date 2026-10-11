/**
 * Whether the app is in its dark theme, read reactively: a component that draws something in the
 * theme, such as a quoted drawing (`RenderedSource.svelte`) or a quoted map's picture
 * (`QuotedMap.svelte`), reads it in a `$derived` and draws again whenever the theme changes, as the
 * editor redraws its rendered widgets (rendered-common.ts).
 */
import { THEME_CHANGE_EVENT } from '@appsoftwareltd/etherpk-shared/theme'
import { createSubscriber } from 'svelte/reactivity'

import { isDark } from './augmentations/rendered-common'

const watchTheme = createSubscriber((update) => {
    window.addEventListener(THEME_CHANGE_EVENT, update)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, update)
})

/** The app's theme now, heard again whenever it changes. */
export function appIsDark(): boolean {
    watchTheme()
    return isDark()
}
