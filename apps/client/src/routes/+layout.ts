import { installedLayoutData } from '#lib/native/layout-data.js'

import type { LayoutLoad } from './$types'

/**
 * What the server cannot know in a Native App, whose pages it never renders: the page was built
 * once, for everyone. In a browser the server's data is passed on as it is.
 */
export const load: LayoutLoad = async ({ data }) => ({ ...data, ...(await installedLayoutData()) })
