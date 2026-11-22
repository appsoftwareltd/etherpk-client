<script lang="ts">
    /**
     * What a [[Plain Folder]]'s main region shows before a file is open: a sentence saying what the
     * folder is and how to open something. A pane's empty state starts at its top left (Style Guide,
     * Layout).
     */
    import type { ViewProps } from '#lib/layout/index.js'

    import { plainSession } from '../plain-session.svelte'

    // Every View is handed its ViewRef; this one shows the folder, not a target.
    let { view: _view }: ViewProps = $props()
</script>

<div class="start" data-testid="plain-start">
    <p>
        <strong>{plainSession.current?.name ?? 'This folder'}</strong> is open as a Plain Folder. Choose a file from the tree to read or edit it. EtherPK changes only the files you
        edit.
    </p>
</div>

<style>
    .start {
        height: 100%;
        padding: 1rem 1.25rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    p {
        max-width: 36rem;
        margin: 0;
    }
    strong {
        color: var(--gk-text-strong);
        font-weight: 600;
    }
</style>
