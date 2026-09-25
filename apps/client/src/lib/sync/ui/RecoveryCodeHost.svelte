<script lang="ts">
    /**
     * Hosts the [[Recovery Code]] ritual once, in the app shell, so it can be answered from
     * whatever route the user is on (ADR 0035). A background [[Import]] on a fresh account
     * finishes wherever they have wandered to, and until the code is acknowledged the vault
     * has not been written - so this prompt cannot belong to the page that started it.
     */
    import {
        cancelRecoveryCode,
        confirmRecoveryCode,
        getRecoveryCodePrompt,
        subscribeRecoveryCodePrompt,
        type RecoveryCodePrompt,
    } from "../recovery-code-prompt";
    import RecoveryCodeDialog from "./RecoveryCodeDialog.svelte";

    let prompt = $state<RecoveryCodePrompt>(getRecoveryCodePrompt());
    $effect(() => subscribeRecoveryCodePrompt((s) => (prompt = s)));
</script>

{#if prompt.code !== null}
    <!--
        Neither arrival has written anything when this renders: a first mint commits on
        confirm, and a regenerate re-wraps on confirm (ADR 0029, amended 2026-09-17). Only a
        regenerate carries a cancel, because only it has a current code worth keeping.
    -->
    <RecoveryCodeDialog
        code={prompt.code}
        arrival={prompt.arrival}
        reason={prompt.reason}
        onconfirm={() => void confirmRecoveryCode()}
        oncancel={prompt.cancel ? cancelRecoveryCode : undefined}
    />
{/if}
