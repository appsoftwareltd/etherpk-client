/** How long the top bar and the page buttons stay once they are up with nothing holding them. */
export const CONTROLS_SHOWN_MS = 5000

export interface ControlsNeeds {
    /** They hide at all: a person reading on a touch phone, who has not switched it off. */
    on: boolean
    /** Something a person opened or turned on needs them: this brings them back, and keeps them. */
    opened: boolean
    /** Something is in hand, as a selection or a note being typed is: this keeps them if they are up, and brings nothing back. */
    busy: boolean
}

/**
 * When the phone's top bar and page buttons are up, while a PDF is read. Plain, with the reader keeping
 * the one reactive copy, because this tier of test does not compile runes and the rules are what need
 * testing: each way they come back starts the same wait, and nothing hides what something open needs.
 */
export class HidingControls {
    private up = true
    private needs: ControlsNeeds = { on: false, opened: false, busy: false }
    private timer: ReturnType<typeof setTimeout> | undefined

    /**
     * @param typing Asked when the wait is up, for a form field with the keyboard. Asked rather than told,
     * because a browser may send no blur for a field that leaves the page as the page turns.
     */
    constructor(
        private readonly hiddenChanged: (hidden: boolean) => void,
        private readonly typing: () => boolean,
    ) {}

    get on(): boolean {
        return this.needs.on
    }

    update(needs: ControlsNeeds): void {
        this.needs = needs
        // Switched off and on again starts from up, not from however it last stood.
        this.put(this.up || needs.opened || !needs.on)
    }

    /** A tap on the page, which is answered with whether they are now up. */
    toggle(): boolean {
        this.put(!this.up || this.needs.opened)
        return this.up
    }

    show(): void {
        this.put(true)
    }

    /** A press on the top bar or the Command Bar. A person using them is not done with them. */
    pressed(): void {
        if (this.up) this.put(true)
    }

    destroy(): void {
        clearTimeout(this.timer)
    }

    private put(up: boolean): void {
        this.up = up
        clearTimeout(this.timer)
        const { on, opened, busy } = this.needs
        if (up && on && !opened && !busy) this.timer = setTimeout(() => this.put(this.typing()), CONTROLS_SHOWN_MS)
        this.hiddenChanged(on && !up)
    }
}
