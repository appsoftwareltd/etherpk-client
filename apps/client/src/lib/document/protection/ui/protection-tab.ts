/**
 * What the Protected Documents tab of the Settings modal needs.
 *
 * A module rather than a type inside the component, because both the Settings modal and the
 * workspace that fills it need to name the shape, and a Svelte instance script cannot export a
 * type.
 */
import type { LockPreferences } from '../protection-settings'

export interface ProtectionTabProps {
    /** Whether this graph has a Protection Key yet — decides between the tab and its empty state. */
    isConfigured: boolean
    /** Whether the key is in memory. Binding a passkey needs it, so the row explains itself. */
    isUnlocked: boolean
    /** The per-device lock timings (ADR 0058) and what a Lock Now does to the tab strip. */
    lockSettings: LockPreferences
    /** False on a browser with no WebAuthn at all — the passkey row is then not offered. */
    canBindPasskey: boolean
    hasPasskey: boolean
    /** Persist a changed preference. Written immediately rather than on Save: they are per-device. */
    onsettings: (next: LockPreferences) => void
    /** Start protection on a graph that has none — opens the set-passphrase dialog. */
    onsetup: () => void
    onbindpasskey: () => Promise<void>
    onchangepassphrase: (current: string, next: string) => Promise<void>
}
