/**
 * The Device Passcode's state (ADR 0129) as a component reads it: setting, unlocking, locking or
 * turning it off, in this tab or another, updates whatever read it.
 */
import { createSubscriber } from 'svelte/reactivity'
import { devicePasscode, type DevicePasscodeState } from '../device-passcode'

const subscribe = createSubscriber((update) => {
    const stop = devicePasscode.onChange(update)
    return () => void stop()
})

export function devicePasscodeState(): DevicePasscodeState {
    subscribe()
    return devicePasscode.state()
}
