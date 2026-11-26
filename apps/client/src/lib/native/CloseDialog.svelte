<script lang="ts">
    /**
     * Asked when the window of a Native App is closed while something would be lost (close-guard.svelte.ts).
     * The window has been told to stay, so nothing is lost while the question waits.
     */
    import ConfirmDialog from "@appsoftwareltd/etherpk-shared/confirm-dialog";

    import { closePrompt } from "./close-guard.svelte.js";
</script>

<ConfirmDialog
    open={closePrompt.losses.length > 0}
    title="Close EtherPK?"
    message={closePrompt.losses.join(" ")}
    confirmLabel="Close anyway"
    cancelLabel="Keep open"
    destructive
    onconfirm={() => void closePrompt.closeAnyway()}
    oncancel={() => closePrompt.keepOpen()}
/>
