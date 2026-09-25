# EtherPK themes

The first-party themes a published site can use (ADR 0082): EtherPK's own `etherpk-docs` and
`etherpk-blog`, and four written in the mould of themes people know from Hugo and Jekyll -
`etherpk-papermod` (PaperMod), `etherpk-stack` (Stack), `etherpk-terminal` (Terminal) and
`etherpk-al-folio` (al-folio). A theme is data, never code that runs in EtherPK: Mustache
templates under `layouts/` and `partials/`, a stylesheet and scripts under `assets/`, and a
`theme.json` naming the view contract it was written for. All ship inside the Client and the
Headless Client through `src/index.ts`, which reads every file at build time.

The four replicas reproduce the look - layout, type, colours, the light / dark toggle where the
original has one - and are written from scratch for EtherPK's view: no template, stylesheet or
script from the originals is copied (PaperMod, Terminal and al-folio are MIT, Stack is GPL-3.0,
and this package stays under the repository's licence). They use system fonts rather than the
originals' web fonts, so a published site still loads nothing from anywhere. Each theme's own
script tags live in `partials/theme-scripts.html`; the `scripts` include slot is an empty partial
rendered after them, so a page filling it adds to the theme rather than replacing search or the
toggle.

To make your own, copy a directory, change what you like, and either point a publication at
your `theme.json` by url (any host that sends CORS headers) or add it to a graph from
**Settings → Publish → Add theme**. The view a template sees, the include slots and the classes
the rendered content carries are documented in the user guide
[Theming A Published Site](https://docs.etherpk.com/theming-a-published-site).

Both put the EtherPK icon (inline in `partials/logo.html`)
before the site title, declared as the `logo` include slot so a publication swaps it from a
page. The docs theme's sidebar is a drawer on a small screen: the hamburger button sits in
`shell-top.html` rather than the `header` partial, so a replaced header keeps the drawer
reachable, and `assets/search.js` runs both the drawer and search.

Every theme here is rendered over a fixture graph by `apps/client/src/lib/document/publish/bundled-themes.test.ts`,
so a change that breaks one fails the unit suite before it ships.
