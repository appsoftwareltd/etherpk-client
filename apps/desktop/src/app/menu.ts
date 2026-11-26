/**
 * The application menu, which is not shown: it is where keys that belong to the window come from.
 * None of them is a key of the Client's. Reload is not among them, since it would lose what the page
 * had not saved and an app has no use for it.
 */
import { Menu, type MenuItemConstructorOptions } from 'electron'
import { COPY } from '../copy.ts'

export function menuTemplate(packaged: boolean): MenuItemConstructorOptions[] {
    // Chromium edits text itself on Windows and Linux. The roles are here for the systems that look
    // for them in a menu, and take no keys from the editor.
    const role = (name: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll', label: string): MenuItemConstructorOptions => ({ role: name, label, registerAccelerator: false })
    return [
        { label: COPY.edit, submenu: [role('undo', COPY.undo), role('redo', COPY.redo), { type: 'separator' }, role('cut', COPY.cut), role('copy', COPY.copy), role('paste', COPY.paste), role('selectAll', COPY.selectAll)] },
        {
            label: COPY.view,
            submenu: [
                { role: 'zoomIn', label: COPY.zoomIn, accelerator: 'CommandOrControl+Plus' },
                // The same key without Shift, which is what the key is called on most keyboards.
                { role: 'zoomIn', label: COPY.zoomIn, accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true },
                { role: 'zoomOut', label: COPY.zoomOut, accelerator: 'CommandOrControl+-' },
                { role: 'resetZoom', label: COPY.zoomReset, accelerator: 'CommandOrControl+0' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: COPY.fullScreen, accelerator: 'F11' },
                ...(packaged ? [] : [{ role: 'toggleDevTools' as const, accelerator: 'F12' }]),
            ],
        },
    ]
}

export function setMenu(packaged: boolean): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(packaged)))
}
