import { describe, expect, it } from 'vitest'
import { describeWriteRefusal, writeRefusalForAgent } from './write-refusal'

describe('describeWriteRefusal', () => {
    it('tells a lapsed owner their changes stay on the device, and offers Restart Sync+', () => {
        const copy = describeWriteRefusal({ refusal: { quotaCode: 'entitlement_inactive' }, owner: true, plan: 'ended', managed: true })
        expect(copy.reason).toBe('Your Sync+ subscription has ended, so the graphs you own are read-only.')
        expect(copy.next).toBe('Your changes are kept on this device and sync once you restart Sync+.')
        expect(copy.billing).toEqual({ label: 'Restart Sync+' })
    })

    it('words an overdue payment as a payment to fix, not a cancellation', () => {
        const copy = describeWriteRefusal({ refusal: { quotaCode: 'entitlement_inactive' }, owner: true, plan: 'payment_overdue', managed: true })
        expect(copy.reason).toBe('A Sync+ payment is overdue, so the graphs you own are read-only.')
        expect(copy.billing).toEqual({ label: 'Fix payment' })
    })

    it('says an unconfirmed plan is temporary and offers nothing to buy', () => {
        const copy = describeWriteRefusal({ refusal: { quotaCode: 'entitlement_inactive' }, owner: true, plan: 'unconfirmed', managed: true })
        expect(copy.reason).toBe('The sync server cannot confirm your plan with EtherPK at the moment.')
        expect(copy.next).toBe('Your changes are kept on this device and sync on their own once it can.')
        expect(copy.billing).toBeNull()
    })

    it("tells a Player it is the owner's plan, and offers them no billing link", () => {
        const copy = describeWriteRefusal({ refusal: { quotaCode: 'entitlement_inactive' }, owner: false, plan: null, managed: true })
        expect(copy.reason).toBe("The owner's plan does not allow changes to this graph at the moment.")
        expect(copy.next).toBe("Your changes are kept on this device and sync once the owner's plan is active again.")
        expect(copy.billing).toBeNull()
    })

    it('names a storage allowance, for the owner and for everyone else', () => {
        expect(
            describeWriteRefusal({ refusal: { quotaCode: 'owned_storage_limit' }, owner: true, plan: null, managed: true }),
        ).toMatchObject({
            reason: 'You have reached your plan’s storage allowance.',
            next: 'Your changes are kept on this device and sync once there is room: delete unused documents or assets, or move to a larger plan.',
            billing: { label: 'Open Billing' },
        })
        expect(
            describeWriteRefusal({ refusal: { quotaCode: 'owned_storage_limit' }, owner: false, plan: null, managed: false }),
        ).toMatchObject({ reason: 'The graph owner has reached their storage allowance on this sync server.', billing: null })
    })

    it('gives a self-hosted refusal the server limits as its reason, not a second "not accepting"', () => {
        // The chip already opens with "The sync server is not accepting changes to this graph."
        expect(describeWriteRefusal({ refusal: { quotaCode: 'entitlement_inactive' }, owner: null, plan: null, managed: false }).reason).toBe(
            'This sync server’s limits do not allow changes to this graph at the moment.',
        )
    })

    it('still says something true when it could not tell who owns the graph or why', () => {
        const copy = describeWriteRefusal({ refusal: {}, owner: null, plan: null, managed: false })
        expect(copy.reason).toBe('A plan limit on this sync server does not allow more changes at the moment.')
        expect(copy.next).toBe('Your changes are kept on this device and sync on their own once it does.')
        expect(copy.billing).toBeNull()
    })
})

describe('writeRefusalForAgent', () => {
    it('says the edit was refused and is held, not that it will be delivered when the connection recovers', () => {
        expect(writeRefusalForAgent({ quotaCode: 'entitlement_inactive' }, 2)).toBe(
            "The Sync Server refused the edit: the graph owner's plan does not allow changes at the moment (a lapsed, unpaid or unconfirmed plan). 2 operations are held here and sent automatically once the server accepts changes again.",
        )
    })
})
