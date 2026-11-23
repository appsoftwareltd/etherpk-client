<script lang="ts">
    /**
     * Which side the [[Primary Sidebar]] is on (ADR 0199): a select on the General tab of a graph's
     * settings and in a [[Plain Folder]]'s settings. The same choice as **Move Primary Sidebar to
     * the right** on the Activity Bar's menu.
     *
     * It is part of the person's [[Sidebar Arrangement]], kept with their settings and not with the
     * graph, so it applies the moment it changes and a form's Save has nothing to commit for it.
     * The workspace follows the setting, which is all this writes.
     */
    import { createSubscriber } from 'svelte/reactivity'

    import { personSettings } from '#lib/person-settings/person-settings.js'
    import type { SidebarSide } from '#lib/layout/index.js'

    import { SIDEBAR_ARRANGEMENT_SETTING } from '../sidebar-arrangement-binding'
    import { DEFAULT_ARRANGEMENT, parseArrangement, sameArrangement, serializeArrangement } from '../sidebar-arrangement'

    const settings = personSettings()
    // The setting lives outside Svelte; reading it subscribes, so the select follows a change made
    // from the Activity Bar's menu, in another tab or on another device.
    const watchSetting = createSubscriber((update) => settings.subscribe(update))
    const side = $derived.by(() => {
        watchSetting()
        return parseArrangement(settings.get(SIDEBAR_ARRANGEMENT_SETTING)).primarySide
    })

    function choose(primarySide: SidebarSide) {
        const next = { ...parseArrangement(settings.get(SIDEBAR_ARRANGEMENT_SETTING)), primarySide }
        // A person back at the defaults has no arrangement of their own to keep.
        settings.set(SIDEBAR_ARRANGEMENT_SETTING, sameArrangement(next, DEFAULT_ARRANGEMENT) ? null : serializeArrangement(next))
    }
</script>

<div class="gk-field" data-testid="primary-sidebar-setting">
    <label class="gk-label" for="primary-sidebar-side">Primary Sidebar</label>
    <select
        id="primary-sidebar-side"
        class="gk-select"
        value={side}
        aria-describedby="primary-sidebar-side-hint"
        data-testid="primary-sidebar-side"
        onchange={(event) => choose(event.currentTarget.value as SidebarSide)}
    >
        <option value="left">On the left</option>
        <option value="right">On the right</option>
    </select>
    <p class="gk-hint" id="primary-sidebar-side-hint">
        The Primary Sidebar is the one with the column of icons. The Secondary Sidebar, with tabs, takes the other side.
        This setting is yours, not the graph's: it applies at once, in every graph and folder you open, and on your other
        devices when your account syncs a graph.
    </p>
</div>
