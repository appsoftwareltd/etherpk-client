/**
 * The [[Graph View]] extension's entry module (ADR 0117, ADR 0122): what the Client imports from
 * this bundle, at run time, from its own origin. It exports `activate`, which the Client calls as
 * each graph opens with that graph's context.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import GraphViewShell from './GraphViewShell.svelte'
import { registerGraphView } from './register'
import './styles.css'
import { svelteView } from './svelte-view.svelte'

export function activate(context: ExtensionContext): () => void {
    const view = svelteView(GraphViewShell)
    return registerGraphView(context, { local: view, whole: view })
}
