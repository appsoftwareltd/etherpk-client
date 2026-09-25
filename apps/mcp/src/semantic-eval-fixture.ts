/**
 * The [[Semantic Search]] evaluation set: a small graph in EtherPK's own style and the
 * questions a user (or an agent) would actually ask of it, each with the document that should
 * come back. Run against the real model by `semantic-eval.test.ts`, which reports recall@10 for
 * each kind of query rather than gating on it - the point is a number that moves when chunking,
 * the floor or the model changes, and cannot move by accident.
 *
 * Two kinds of query. `lexical` ones share a distinctive word with their document, which text
 * search already answers and semantic search must not lose. `meaning` ones share no useful word
 * with it - the reason the mode exists. `JUNK` should match nothing above the floor.
 */

import type { IndexDoc } from '$lib/document/index-db'

export const DOCS: IndexDoc[] = [
    {
        concept: 'Sync Reliability',
        kind: 'page',
        aliases: [],
        text: [
            '# Relay reconnect',
            '- when the socket drops, every tab reconnects at once and the relay is hammered - the reconnect storm',
            '- the fix is exponential backoff with jitter, capped at thirty seconds',
            '- a tab that has been asleep resumes with a full watermark comparison, not a replay',
            '# Outbox',
            '- unacknowledged edits replay from the outbox on reconnect; the relay dedups by client sequence',
        ].join('\n'),
    },
    {
        concept: 'Asset Retention',
        kind: 'page',
        aliases: [],
        text: [
            '- an uploaded file dies only with its last reference; nothing deletes bytes a page still shows',
            '- orphaned chunks (uploads whose page was never saved) are swept after thirty days',
            '- the dedup token is blinded client-side, so the server cannot tell two members uploaded the same image',
            '- the permanent delete dialog counts references first and refuses while any remain',
        ].join('\n'),
    },
    {
        concept: 'Billing',
        kind: 'page',
        aliases: ['Payments'],
        text: [
            '- the Stripe webhook for online orders is handled by the order service, never the storefront',
            '- a failed card payment holds the order for three days, then cancels it and emails the customer',
            '- refunds go back to the original card; allow five working days',
            '- the loyalty discount starts from the second order',
        ].join('\n'),
    },
    {
        concept: 'Protected Documents',
        kind: 'page',
        aliases: [],
        text: [
            '- a page can be encrypted under a passphrase so that even the search index never sees it',
            '- unlocking exposes every protected page until the next lock; the key is the unit',
            '- protection is whole-document only: a cipher fence beside readable text is not protection',
        ].join('\n'),
    },
    {
        concept: 'Release Process',
        kind: 'page',
        aliases: [],
        text: [
            '- bump the version, tag it, and let CI build and publish the package',
            '- write the changelog entry before tagging, not after',
            '- a fresh version can take a few minutes to appear in the registry',
        ].join('\n'),
    },
    {
        concept: 'Sourdough',
        kind: 'page',
        aliases: [],
        text: [
            '- feed the starter twelve hours before mixing; it should double and smell sweet, not sour',
            '- 75% hydration for the everyday loaf; higher and the crumb goes gummy',
            '- if the dough stays flat after bulk fermentation the starter was too weak or the kitchen too cold',
            '- score deep and bake in the dutch oven lid-on for twenty minutes',
        ].join('\n'),
    },
    {
        concept: 'Chocolate Cake',
        kind: 'page',
        aliases: [],
        text: '- dark chocolate, 70%, melted into the butter\n- do not overbake: the centre should wobble slightly\n- a pinch of salt in the ganache',
    },
    {
        concept: 'Running Plan',
        kind: 'page',
        aliases: [],
        text: [
            '- couch to 5k, three sessions a week, walk breaks allowed',
            '- the inside of the knee aches after the longer runs; try the shoes with more cushioning and shorten the stride',
            '- rest day is not optional',
        ].join('\n'),
    },
    {
        concept: 'Self Assessment',
        kind: 'page',
        aliases: ['Tax Return'],
        text: [
            '- the return and the balancing payment are due 31 January; payments on account on 31 January and 31 July',
            '- HMRC gateway password is in the password manager under Government',
            '- keep every invoice PDF in the year folder; the accountant asks for them in November',
        ].join('\n'),
    },
    {
        concept: 'Mortgage',
        kind: 'page',
        aliases: [],
        text: '- the fixed rate ends in March; the broker says start the remortgage six months out\n- overpayment allowance is 10% a year without penalty',
    },
    {
        concept: 'Lisbon Trip',
        kind: 'page',
        aliases: [],
        text: [
            '- tram 28 early, before the queues; Alfama on foot',
            '- pastel de nata at the original bakery in Belem',
            '- day trip to Sintra by train from Rossio; the palace tickets sell out',
        ].join('\n'),
    },
    {
        concept: 'Deep Work',
        kind: 'page',
        aliases: [],
        text: '- Cal Newport: the ability to concentrate without distraction is becoming rare and valuable\n- schedule focus blocks of ninety minutes with the phone in another room\n- shallow work expands to fill the day unless it is fenced',
    },
    {
        concept: 'Pragmatic Programmer',
        kind: 'page',
        aliases: [],
        text: '- tracer bullets: build a thin end-to-end slice first, then thicken it\n- DRY is about knowledge, not code that merely looks alike\n- fix broken windows before they spread',
    },
    {
        concept: 'Tomatoes',
        kind: 'page',
        aliases: [],
        text: '- water at the base in the morning, never the leaves\n- brown patches spreading on the lower leaves is blight: remove and bin them, do not compost\n- feed weekly once the first truss sets',
    },
    {
        concept: 'Car',
        kind: 'page',
        aliases: [],
        text: '- MOT due in October; book the garage on the high street\n- the brake pads were at 3mm last service; expect them to need doing',
    },
    {
        concept: 'School',
        kind: 'page',
        aliases: [],
        text: '- autumn term starts 3 September; half term the last week of October\n- parents evening is online this year, slots booked through the app',
    },
    {
        concept: 'Boiler',
        kind: 'page',
        aliases: [],
        text: '- annual service in September; the engineer is the one the landlord recommended\n- if the radiators are cold and the gauge reads under one bar, top up the pressure with the filling loop under the boiler',
    },
    {
        concept: 'One To One',
        kind: 'page',
        aliases: [],
        text: '- build the case for the next level: three examples of work beyond the current role, with impact\n- ask what would need to be true by the spring review\n- raise the on-call rota',
    },
    {
        concept: 'Hiring',
        kind: 'page',
        aliases: [],
        text: '- two backend roles open; the loop is a screen, a take-home, a pairing session and values\n- the take-home is capped at three hours and we pay for it',
    },
    {
        concept: 'Search Modal',
        kind: 'page',
        aliases: [],
        text: '- two groups, names and text, run separately and paged separately\n- names answer synchronously from the snapshot; text is a worker round trip\n- ranking text by matching-block count, with bm25 only as a tie-break',
    },
    {
        concept: 'Semantic Search Idea',
        kind: 'page',
        aliases: [],
        text: '- find notes by what they are about rather than the exact words in them\n- a small embedding model running locally, so nothing leaves the device\n- a third group in the same modal, never a fused ranking',
    },
    {
        concept: 'Guitar',
        kind: 'page',
        aliases: [],
        text: '- barre chords: thumb behind the neck, roll the index finger slightly\n- practise with the metronome at sixty and only speed up when every change is clean',
    },
    {
        concept: 'Photography',
        kind: 'page',
        aliases: [],
        text: '- shoot RAW; the exposure triangle is aperture, shutter, ISO\n- in dim rooms open the aperture, accept ISO 3200, and brace the camera rather than dropping below 1/60',
    },
    {
        concept: 'Dog',
        kind: 'page',
        aliases: [],
        text: '- annual vaccination booster due in November; the vet sends a reminder\n- the kennels want proof of the booster before the Christmas booking',
    },
    {
        concept: 'Acme Meeting',
        kind: 'page',
        aliases: [],
        text: '- the client keeps adding requirements after sign-off; every addition goes on the change log and is quoted separately\n- invoice on milestone, net thirty; the deadline for phase two is the end of the quarter',
    },
    {
        concept: '2026-08-14',
        kind: 'journal',
        aliases: [],
        text: '- spent the morning on the reconnect storm; backoff with jitter looks right\n- lunch with Sam\n- evening run, knee fine',
    },
    {
        concept: '2026-08-15',
        kind: 'journal',
        aliases: [],
        text: '- dentist at nine\n- the sourdough came out flat again; starter needs feeding twice before the next bake\n- called the plumber about the dripping tap',
    },
    {
        concept: '2026-09-01',
        kind: 'journal',
        aliases: [],
        text: '- decided: uploads nothing references are kept for thirty days, then swept - see [[Asset Retention]]\n- call with Stripe about the webhook retries',
    },
]

export interface EvalQuery {
    query: string
    /** Any of these counts as the right answer. */
    expect: string[]
    kind: 'lexical' | 'meaning'
}

export const QUERIES: EvalQuery[] = [
    // Meaning: no distinctive word in common with the document.
    { query: 'how do I stop the sync loop', expect: ['Sync Reliability', '2026-08-14'], kind: 'meaning' },
    { query: 'when do I have to pay my taxes', expect: ['Self Assessment'], kind: 'meaning' },
    { query: 'what did we decide about keeping old uploads', expect: ['Asset Retention', '2026-09-01'], kind: 'meaning' },
    { query: 'who handles card payment failures', expect: ['Billing'], kind: 'meaning' },
    { query: 'bread not rising', expect: ['Sourdough', '2026-08-15'], kind: 'meaning' },
    { query: 'my leg hurts when jogging', expect: ['Running Plan'], kind: 'meaning' },
    { query: 'the heating has no pressure', expect: ['Boiler'], kind: 'meaning' },
    { query: 'things to see in Portugal', expect: ['Lisbon Trip'], kind: 'meaning' },
    { query: 'book about concentration', expect: ['Deep Work'], kind: 'meaning' },
    { query: 'when is the car inspection', expect: ['Car'], kind: 'meaning' },
    { query: 'getting promoted', expect: ['One To One'], kind: 'meaning' },
    { query: 'tomato leaves going brown', expect: ['Tomatoes'], kind: 'meaning' },
    { query: 'search by concept not keywords', expect: ['Semantic Search Idea'], kind: 'meaning' },
    { query: 'how do we ship a new version of the command line tool', expect: ['Release Process'], kind: 'meaning' },
    { query: 'dog jabs', expect: ['Dog'], kind: 'meaning' },
    { query: 'customer keeps adding requirements', expect: ['Acme Meeting'], kind: 'meaning' },
    { query: 'learning chords', expect: ['Guitar'], kind: 'meaning' },
    { query: 'camera settings for low light', expect: ['Photography'], kind: 'meaning' },
    { query: 'when does the fixed rate end', expect: ['Mortgage'], kind: 'meaning' },
    { query: 'encrypt a page with a password', expect: ['Protected Documents'], kind: 'meaning' },
    { query: 'interview process for engineers', expect: ['Hiring'], kind: 'meaning' },
    { query: 'when does school start', expect: ['School'], kind: 'meaning' },
    // Lexical: a distinctive word the text group already finds.
    { query: 'reconnect storm', expect: ['Sync Reliability', '2026-08-14'], kind: 'lexical' },
    { query: 'Stripe webhook', expect: ['Billing', '2026-09-01'], kind: 'lexical' },
    { query: 'pastel de nata', expect: ['Lisbon Trip'], kind: 'lexical' },
    { query: 'payments on account', expect: ['Self Assessment'], kind: 'lexical' },
    { query: 'tracer bullets', expect: ['Pragmatic Programmer'], kind: 'lexical' },
    { query: 'hydration', expect: ['Sourdough'], kind: 'lexical' },
    { query: 'brake pads', expect: ['Car'], kind: 'lexical' },
    { query: 'parents evening', expect: ['School'], kind: 'lexical' },
    { query: 'barre chords', expect: ['Guitar'], kind: 'lexical' },
    { query: 'orphaned chunks', expect: ['Asset Retention'], kind: 'lexical' },
]

/** Should match nothing above the floor. */
export const JUNK = ['asdf qwerty', 'zzzz', 'purple elephant quantum banjo', 'lorem ipsum dolor sit amet']
