<script lang="ts">
    /**
     * The actions an [[Asset Reference]] offers on a **read-only** surface: copy it to the
     * clipboard when it is an image, download it, and open it in its own tab where a viewer is
     * registered.
     * The same list, in the same order, wired to the same [[Command]]s as the editor's cluster —
     * `asset-affordances.ts` owns it, so the two cannot drift — minus **delete**, which needs the
     * line the reference is written on. A panel quoting another document has no such line, and the
     * Command refuses a target without one, so the button is absent rather than dead.
     * The drawing is `InlineActions.svelte`, shared with the [[File Link]] cluster.
     */
    import { displayNameForRef } from "$lib/storage/fs/asset-store";

    import { assetActions, runAssetCommand } from "../asset-affordances";
    import type { InlineAction } from "../inline-action";
    import InlineActions from "./InlineActions.svelte";

    let {
        ref,
        /** False when the bytes are gone — there is nothing to hand over. */
        canDownload = true,
        /** Icon size in px: 16 is the editor's trailing cluster, 18 its image overlay. */
        size = 16,
    }: { ref: string; canDownload?: boolean; size?: number } = $props();

    // The registered viewers are set when the graph opens, before any View mounts, so this is
    // read once per reference rather than tracked.
    const actions = $derived(assetActions(ref, { canDownload, canDelete: false }));

    /** The file's own name, hash-free: three clusters on one line would otherwise all be
     *  announced as "Download", naming nothing. */
    const name = $derived(displayNameForRef(ref));

    const run = (action: InlineAction) => runAssetCommand(action.command, { kind: "asset", ref });
</script>

<InlineActions kind="asset" subject={ref} {actions} {name} {run} {size} />
