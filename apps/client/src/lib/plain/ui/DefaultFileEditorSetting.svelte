<script lang="ts">
    /**
     * **Default file editor**, in a [[Plain Folder]]'s settings (ADR 0204): the editor a markdown
     * file opens in when none was chosen for that file. The same choice as the last row of the menu
     * on the editor's name above a file.
     *
     * The person's own, kept with their settings and not in the folder, so it applies the moment it
     * changes, to every Plain Folder.
     */
    import { createSubscriber } from 'svelte/reactivity'

    import { personSettings } from '#lib/person-settings/person-settings.js'

    import { FILE_EDITOR_NAMES, type FileEditor, defaultFileEditor, setDefaultFileEditor } from '../file-editors'

    const settings = personSettings()
    // The setting lives outside Svelte; reading it subscribes, so the select follows a change made
    // from a file's own menu, in another tab or on another device.
    const watchSetting = createSubscriber((update) => settings.subscribe(update))
    const editor = $derived.by(() => {
        watchSetting()
        return defaultFileEditor(settings)
    })
</script>

<div class="gk-field" data-testid="default-file-editor-setting">
    <label class="gk-label" for="default-file-editor">Default file editor</label>
    <select
        id="default-file-editor"
        class="gk-select"
        value={editor}
        aria-describedby="default-file-editor-hint"
        data-testid="default-file-editor"
        onchange={(event) => setDefaultFileEditor(settings, event.currentTarget.value as FileEditor)}
    >
        <option value="markdown">{FILE_EDITOR_NAMES.markdown}</option>
        <option value="text">{FILE_EDITOR_NAMES.text}</option>
    </select>
    <p class="gk-hint" id="default-file-editor-hint">
        The editor a markdown file opens in. To change it for one file, select the editor’s name above the file. This
        setting is per user across all Plain Folders, and applies on other devices if your account syncs a graph.
    </p>
</div>
