<script lang="ts">
    /**
     * What installing an extension from the Extension Directory agrees to, said before the person
     * presses Install. An extension runs in the Client's page with no sandbox (ADR 0009), so it can
     * reach what the page can: the documents of the graphs open in it, every extension's settings
     * (secrets are kept in the clear on the device) and any website. Settings and an extension's
     * address both offer Install, and both show this, so they say the same.
     */
    const { name, id }: { name: string; id: string } = $props();
</script>

<div {id} class="space-y-1 text-sm text-gray-950 dark:text-gray-100">
    <p>{name} will run in EtherPK, on this device and on your other devices where you sync with your account. Like every extension, it can:</p>
    <ul class="list-disc space-y-0.5 pl-5">
        <li>Read and change the documents in the graphs you open, protected ones included</li>
        <li>Read every extension's settings, keys included</li>
        <li>Send what it reads to other websites</li>
    </ul>
    <p>It was reviewed before it was listed, and each new release is reviewed before it reaches you.</p>
</div>
