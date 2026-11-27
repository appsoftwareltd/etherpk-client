<script lang="ts">
    /**
     * The Style Guide's specimens (`/dev/style-guide`, 404 in production): each control, colour,
     * text style and shape the guide names, drawn with the real classes and tokens, so a look at
     * this page in each theme shows what the guide's words mean and what a change to
     * `controls.css` or a token does. The rules are in the Style Guide (the design-system folder of the internal docs).
     */
    import { sidebarButton, sidebarIconButton } from "#lib/document/view/sidebar-button.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import PageAddressField from "#lib/workspace/PageAddressField.svelte";
    import { goto } from "$app/navigation";

    const surfaces = ["--gk-surface-0", "--gk-surface-1", "--gk-surface-2", "--gk-field-bg", "--gk-menu-bg", "--gk-primary-bg", "--gk-emphasis-bg"];
    const inks = ["--gk-text-strong", "--gk-text-default", "--gk-text-muted", "--gk-accent", "--gk-text-danger"];
    const borders = ["--gk-border-soft", "--gk-border-strong", "--gk-control-border", "--gk-field-focus"];
    const washes = ["--gk-danger-surface", "--gk-warning-surface", "--gk-success-surface", "--gk-highlight-bg"];
    const radii = [
        ["rounded-md", "6px: small control, chip, or a control inside a card"],
        ["rounded-lg", "8px: control, card"],
        ["rounded-xl", "12px: dialog, large card"],
        ["rounded-full", "Dot, pill, swatch"],
    ];
    const gaps = [
        ["gap-1.5", "6px: icon and label"],
        ["gap-2", "8px: controls in a row"],
        ["gap-4", "16px: fields in a form"],
        ["gap-6", "24px: sections"],
    ];
</script>

<svelte:head><title>Style guide specimens</title></svelte:head>

{#snippet swatches(tokens: string[])}
    <div class="flex flex-wrap gap-3">
        {#each tokens as token (token)}
            <div class="w-40">
                <div class="h-12 rounded-lg border border-(--gk-border-strong)" style:background="var({token})"></div>
                <code class="mt-1 block text-sm text-(--gk-text-muted)">{token}</code>
            </div>
        {/each}
    </div>
{/snippet}

<main class="mx-auto max-w-4xl space-y-10 bg-(--gk-surface-0) p-6 text-sm text-(--gk-text-default)" data-testid="style-guide">
    <header>
        <h1 class="text-2xl font-semibold text-(--gk-text-strong)">Style guide specimens</h1>
        <p class="gk-hint mt-1">Each control, colour, text style and shape the Style Guide names, drawn with the real classes.</p>
    </header>

    <section class="space-y-4" data-testid="style-guide-colour">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Colour</h2>
        <h3 class="gk-label">Surfaces and fills</h3>
        {@render swatches(surfaces)}
        <h3 class="gk-label">Borders</h3>
        {@render swatches(borders)}
        <h3 class="gk-label">States and washes</h3>
        {@render swatches(washes)}
        <h3 class="gk-label">Text</h3>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
            {#each inks as ink (ink)}
                <span style:color="var({ink})">Water the beans <code>{ink}</code></span>
            {/each}
        </div>
    </section>

    <section class="space-y-3" data-testid="style-guide-type">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Type</h2>
        <p class="text-2xl font-semibold text-(--gk-text-strong)">Page heading: text-2xl, semibold</p>
        <p class="text-lg font-semibold text-(--gk-text-strong)">Section heading: text-lg, semibold</p>
        <p class="text-base font-semibold text-(--gk-text-strong)">Dialog title: text-base, semibold</p>
        <p class="gk-label">Label: 14px, medium (gk-label)</p>
        <p>Body: 14px, the default ink. Nothing a person reads is smaller.</p>
        <p class="gk-hint">Help: 14px, muted ink (gk-hint)</p>
        <p class="gk-error">Error: 14px, danger ink (gk-error)</p>
        <p class="font-mono">Code, ids and keys: font-mono at the same size</p>
        <p><button type="button" class="gk-link">A link (gk-link)</button> inside a sentence is underlined.</p>
    </section>

    <section class="space-y-4" data-testid="style-guide-buttons">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Buttons</h2>
        <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="gk-button">gk-button</button>
            <button type="button" class="gk-button gk-button--primary">--primary</button>
            <button type="button" class="gk-button gk-button--emphasis">--emphasis</button>
            <button type="button" class="gk-button gk-button--danger">--danger</button>
            <button type="button" class="gk-button gk-button--quiet">--quiet</button>
            <button type="button" class="gk-button gk-button--raised">--raised</button>
            <button type="button" class="gk-button" aria-pressed="true">Pressed</button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="gk-button" disabled>Disabled</button>
            <button type="button" class="gk-button gk-button--primary" disabled>Disabled primary</button>
            <button type="button" class="gk-button gk-button--small">--small</button>
            <button type="button" class="gk-button">OK</button>
        </div>
        <div class="flex justify-end gap-2 rounded-lg border border-(--gk-border-soft) p-3">
            <span class="gk-hint mr-auto self-center">A dialog's footer: Cancel, then the one primary button.</span>
            <button type="button" class="gk-button">Cancel</button>
            <button type="button" class="gk-button gk-button--primary" data-testid="style-guide-button">Save</button>
        </div>
    </section>

    <!-- eslint-disable svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table (ADR 0130) -->
    <section class="space-y-4" data-testid="style-guide-icon-buttons">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Icon buttons</h2>
        <div class="flex flex-wrap items-end gap-6">
            {#snippet specimen(label: string, attributes: Record<string, unknown>, icon: string)}
                <div class="flex flex-col items-center gap-1.5">
                    <button type="button" class="gk-icon-button" aria-label={label} data-tooltip={label} {...attributes}>{@html iconSvg(icon)}</button>
                    <span class="gk-hint">{label}</span>
                </div>
            {/snippet}
            {@render specimen("More", { "data-testid": "style-guide-icon-button" }, "more")}
            <!-- The hover look, held still for the guide's picture. -->
            {@render specimen("Hover", { style: "background: var(--gk-menu-hover); color: var(--gk-text-strong)" }, "pin")}
            {@render specimen("Pressed", { "aria-pressed": "true", "data-testid": "style-guide-icon-button-pressed" }, "filter")}
            {@render specimen("Disabled", { disabled: true }, "close")}
            <div class="flex flex-col items-center gap-1.5">
                <button type="button" class="gk-icon-button gk-button--raised" aria-label="Raised" data-tooltip="Raised" data-testid="style-guide-icon-button-raised">{@html iconSvg("search")}</button>
                <span class="gk-hint">Raised</span>
            </div>
        </div>
        <div class="flex items-center gap-2 rounded-lg border border-(--gk-border-soft) p-3">
            <span class="gk-hint mr-auto">A toolbar: icon buttons 4px apart, centred on the row's other controls.</span>
            <select class="gk-select gk-select--small" aria-label="Sort">
                <option>Newest</option>
            </select>
            <span class="flex items-center gap-1">
                <button type="button" class="gk-icon-button" aria-label="Filter" data-tooltip="Filter">{@html iconSvg("filter")}</button>
                <button type="button" class="gk-icon-button" aria-label="Pin" data-tooltip="Pin">{@html iconSvg("pin")}</button>
                <button type="button" class="gk-icon-button" aria-label="Close" data-tooltip="Close">{@html iconSvg("close")}</button>
            </span>
        </div>
    </section>

    <section class="space-y-4" data-testid="style-guide-sidebar-buttons">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Sidebar buttons</h2>
        <div class="grid w-76 grid-cols-2 gap-2 rounded-lg border border-(--gk-border-soft) bg-(--gk-surface-1) p-2">
            {#each [["search", "Search"], ["todays-journal", "Today"]] as [icon, label], index (label)}
                <button type="button" class={sidebarButton} data-testid={index === 0 ? "style-guide-sidebar-button" : undefined}>
                    <span class="inline-flex shrink-0 items-center gap-1.5">
                        <span class="inline-flex shrink-0 text-(--gk-text-subtle)" aria-hidden="true">{@html iconSvg(icon, { size: 16 })}</span>
                        <span class="whitespace-nowrap">{label}</span>
                    </span>
                </button>
            {/each}
        </div>
        <div class="grid w-76 grid-cols-2 gap-2 rounded-lg border border-(--gk-border-soft) bg-(--gk-surface-1) p-2">
            {#each [["search", "Search"], ["todays-journal", "Today's journal"]] as [icon, label] (label)}
                <button type="button" class={sidebarIconButton} aria-label={label} data-tooltip={label}>{@html iconSvg(icon, { size: 18 })}</button>
            {/each}
        </div>
        <p class="gk-hint">Labelled in the Sidebar (34px), and the icon alone under the phone layout (36px, 44px under a finger).</p>
    </section>
    <!-- eslint-enable svelte/no-at-html-tags -->

    <section class="space-y-4" data-testid="style-guide-fields">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Fields</h2>
        <div class="grid gap-4 sm:grid-cols-2">
            <div class="gk-field">
                <label class="gk-label" for="sg-text">Text field (gk-input)</label>
                <input id="sg-text" class="gk-input" placeholder="e.g. Garden" data-testid="style-guide-input" />
                <p class="gk-hint">Help sits under the control.</p>
            </div>
            <div class="gk-field">
                <label class="gk-label" for="sg-select">Select (gk-select w-full)</label>
                <select id="sg-select" class="gk-select w-full" data-testid="style-guide-select">
                    <option>Garden</option>
                    <option>Kitchen</option>
                </select>
                <p class="gk-hint">The same fill, border and height as the field.</p>
            </div>
            <div class="gk-field">
                <label class="gk-label" for="sg-invalid">Invalid (aria-invalid)</label>
                <input id="sg-invalid" class="gk-input" value="garden@" aria-invalid="true" aria-describedby="sg-invalid-error" />
                <p id="sg-invalid-error" class="gk-error">Enter a full email address, such as name@example.com.</p>
            </div>
            <div class="gk-field">
                <label class="gk-label" for="sg-disabled">Disabled</label>
                <input id="sg-disabled" class="gk-input" value="Kitchen" disabled />
                <p class="gk-hint">Say beside it why it is disabled.</p>
            </div>
            <div class="gk-field">
                <label class="gk-label" for="sg-area">Text area (gk-input)</label>
                <textarea id="sg-area" class="gk-input" rows="3" placeholder="- water the beans"></textarea>
            </div>
            <div class="space-y-3">
                <label class="flex items-center gap-2">
                    <input type="checkbox" class="gk-checkbox" checked />
                    Checkbox (gk-checkbox)
                </label>
                <div class="flex flex-wrap items-center gap-2" data-testid="style-guide-toolbar">
                    <input class="gk-input gk-input--small w-40" placeholder="Find" aria-label="Small field" data-testid="style-guide-input-small" />
                    <select class="gk-select gk-select--small" aria-label="Small select" data-testid="style-guide-select-small">
                        <option>100%</option>
                        <option>150%</option>
                    </select>
                    <button type="button" class="gk-button gk-button--small" data-testid="style-guide-button-small">Next</button>
                </div>
                <p class="gk-hint">A toolbar row: the small field, select and button, all 30px.</p>
                <!-- The workspace toolbar's address (PageAddressField, asText): this page's own address,
                     drawn as muted text that is edited in place. -->
                <div class="flex items-center" data-testid="style-guide-address">
                    <PageAddressField small asText id="style-guide-address-input" ongo={(path) => void goto(path)} />
                </div>
                <p class="gk-hint">The workspace toolbar's address: text you can edit, muted until the pointer is over it.</p>
            </div>
        </div>
    </section>

    <section class="space-y-3" data-testid="style-guide-menu">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Menu</h2>
        <div class="gk-menu w-56" role="menu">
            <button type="button" class="gk-menu-item" role="menuitem">Open in a new tab</button>
            <button type="button" class="gk-menu-item" role="menuitem">Copy name</button>
            <hr class="gk-menu-separator" />
            <button type="button" class="gk-menu-item gk-menu-item--danger" role="menuitem">Delete</button>
        </div>
    </section>

    <section class="space-y-4" data-testid="style-guide-shape">
        <h2 class="text-lg font-semibold text-(--gk-text-strong)">Shape and spacing</h2>
        <div class="flex flex-wrap gap-4">
            {#each radii as [radius, use] (radius)}
                <div class="w-40">
                    <div class={["h-12 border border-(--gk-border-strong) bg-(--gk-surface-1)", radius]}></div>
                    <code class="mt-1 block text-(--gk-text-strong)">{radius}</code>
                    <span class="gk-hint">{use}</span>
                </div>
            {/each}
        </div>
        <div class="space-y-2">
            {#each gaps as [gap, use] (gap)}
                <div class="flex items-center gap-3">
                    <div class={["flex", gap]}>
                        <span class="size-6 rounded-md bg-(--gk-surface-2)"></span>
                        <span class="size-6 rounded-md bg-(--gk-surface-2)"></span>
                        <span class="size-6 rounded-md bg-(--gk-surface-2)"></span>
                    </div>
                    <code class="w-20 text-(--gk-text-strong)">{gap}</code>
                    <span class="gk-hint">{use}</span>
                </div>
            {/each}
        </div>
        <div class="max-w-md rounded-xl border border-(--gk-border-strong) bg-(--gk-surface-0) p-5">
            <h3 class="text-base font-semibold text-(--gk-text-strong)">A card or dialog panel</h3>
            <p class="mt-1">rounded-xl, a strong border and p-5. A shadow is for what floats: menus, dialogs and toasts.</p>
        </div>
    </section>
</main>
