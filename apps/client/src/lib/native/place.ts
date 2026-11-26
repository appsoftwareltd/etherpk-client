/**
 * The words for where EtherPK keeps what it keeps on a device. In a browser that is the browser, and a
 * person can lose it by clearing the browser's data. In a Native App it is the app, and naming a
 * browser would send them to look for one.
 */
import { isNativeApp } from './bridge.js'

/** "this browser", or "this app". */
export const THIS_PLACE = isNativeApp() ? 'this app' : 'this browser'

/** The same, to start a sentence. */
export const THIS_PLACE_START = isNativeApp() ? 'This app' : 'This browser'

/** The same, with no pointing word. */
export const THE_STORE = isNativeApp() ? 'the app' : 'the browser'

/** Whose languages the spell checker starts with. */
export const THE_STORE_YOURS = isNativeApp() ? "your system's" : "your browser's"

/** The same as another program, such as an agent, is told of it. */
export const THE_KEEPER = isNativeApp() ? 'the EtherPK app' : 'this browser'

/** Where else EtherPK may be open on this device, to start a sentence. */
export const ANOTHER_TAB = isNativeApp() ? 'Another EtherPK window' : 'Another tab of this browser'

/** Opening EtherPK here, after "you". */
export const OPEN_HERE = isNativeApp() ? 'open EtherPK' : 'open EtherPK in this browser'

/** "the browser", or "the system", as the one that asks and refuses. */
export const THE_ASKER = isNativeApp() ? 'the system' : 'the browser'

/** How to start the page again, as the start of a sentence. A Native App has no reload button. */
export const START_AGAIN = isNativeApp() ? 'Close EtherPK and open it again' : 'Reload the page'

/** Where a newer version comes from, as the start of a sentence. Closing an app does not update it. */
export const GET_LATEST = isNativeApp() ? 'Update EtherPK' : 'Reload the page to get the latest version'

/** What the storage figure is out of, after "of the 2 GB". A browser sets a limit; an app has the device's room. */
export const STORAGE_LIMIT_OF = isNativeApp() ? 'available' : 'this browser allows'

/** Where to export a graph too large to export here, as the end of a sentence. */
export const EXPORT_ELSEWHERE = isNativeApp() ? 'Export the graph from a desktop instead.' : 'Export it from a desktop browser instead.'
