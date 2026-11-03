# Excalidraw for EtherPK

[Excalidraw](https://excalidraw.com) drawings in EtherPK documents. A Built-in Extension compiled
into the Client: it comes with EtherPK and needs no installing. A drawing is kept in the document
itself, so it syncs, moves and versions with the text around it, and you can keep drawing on it
whenever you like.

## What it does

- **`/drawing`** in a document, on a desktop (**Excalidraw (drawing)** in the menu), puts a new
  drawing at the caret, ready to draw on.
- **Draw in place.** A drawing shows as a picture. Click it to draw, and click outside it, or press
  Done, to go back to the picture. What you draw is saved as you draw.
- **Open in tab** opens the drawing in a tab of its own, with more room.
- **Full window** fills the EtherPK window with the drawing. Press Return to go back. Esc stays with
  Excalidraw, which uses it to leave a tool.
- **Edit as text and Delete** are in the menu at the top right of a drawing's picture (the `…`
  button), and in the bar above a drawing you are drawing on. Edit as text shows the drawing's lines
  in the document. Delete removes the drawing at once. Press Mod+Z in the document to bring it back.
- **Bring a drawing from excalidraw.com.** Paste a share link
  (`https://excalidraw.com/#json=…`) on an empty line, and press **Import this drawing from
  excalidraw.com** on the card that appears. Nothing is fetched from excalidraw.com until you press
  it. The drawing then lives in your document, and the link and its key are gone from it. You can
  also copy shapes on excalidraw.com and paste them on an empty line. Images aren't brought across,
  since a drawing in EtherPK holds none.
- **Phones and tablets under 1024 pixels wide** show drawings as pictures. Tap one to see it bigger.
  Drawing is for a desktop.
- **Published sites.** On a site you publish from EtherPK, a drawing is a picture of it, an SVG file
  with its fonts inside. The drawing's data is never on the site.
- **Backlinks.** Where a block that links to a page holds a drawing, the page's backlinks show the
  drawing as a picture. Click it to open the document it is in.
- **Light in both themes.** In EtherPK's dark theme a drawing is still drawn light, its editor and
  its pictures alike, so it shows the colours it holds rather than Excalidraw's inverted ones.

What Excalidraw can do that reaches other services is switched off: its library browser, sharing,
web embeds, its AI features and its help and social links. The image tool is off too, since images
belong in EtherPK's own assets.

## How a drawing is stored

A drawing is a fenced block whose info word is `excalidraw.drawing`. Its first line names the
drawing (its own `id`, which lets EtherPK find it again for a tab) and its canvas colour. Each line
after it is one Excalidraw element, as Excalidraw writes it:

````markdown
```excalidraw.drawing
{"type":"excalidraw.drawing","version":1,"id":"k3v9q2m8xa","background":"#ffffff"}
{"id":"r1","type":"rectangle","version":4,"versionNonce":81,"x":0,"y":0,"width":160,"height":80,…}
```
````

Because each element is a line of its own, a change saves only the lines of the elements that
changed, and two devices drawing at once merge element by element.

A save never removes what it didn't load. A line is removed only when you delete that element.
Lines the extension can't read stay as they are: broken JSON, a note in words, or a shape this
Excalidraw doesn't know, such as one made with a newer Excalidraw.

### Writing shapes by hand

A shape can also be written without Excalidraw's bookkeeping, in Excalidraw's own
[skeleton form](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton):
a `type`, a position and a size, and no `version`. A label inside a shape, and an arrow joining two
shapes by their ids, are written the same way:

````markdown
```excalidraw.drawing
{"type":"excalidraw.drawing","version":1,"id":"k3v9q2m8xa","background":"#ffffff"}
{"id":"beds","type":"rectangle","x":0,"y":0,"width":160,"height":80,"label":{"text":"Beds"}}
{"id":"shed","type":"ellipse","x":300,"y":0,"width":120,"height":80,"label":{"text":"Shed"}}
{"type":"arrow","x":160,"y":40,"start":{"id":"beds"},"end":{"id":"shed"}}
```
````

When the drawing is next shown, the extension draws these shapes and writes them back as full
Excalidraw elements in their place. Two devices doing so at once write the same elements.

EtherPK treats a block named `<extension id>.<name>` as an Extension Fence: it never searches it,
never shows its lines unless you ask (Edit as text), and never publishes it as code. With the
extension switched off, EtherPK shows a note that the drawing comes from the Excalidraw extension,
with a button to show its text. Words written in a drawing aren't found by EtherPK's search yet.

## Terms

- **Drawing**: an `excalidraw.drawing` block, and the picture or live editor the extension draws
  for it.
- **Live drawing**: a drawing open for drawing on, as opposed to its picture. Only one is live in a
  document at a time.

## How it is built

The extension is compiled with the Client (`src/extension.ts` is its entry). Excalidraw 0.18.1 is
pinned, with React, and both load only when a document first shows a drawing, so the Client's first
load carries neither.

The Client's build adds the plugins in `build-plugins/vite-plugins.ts`, which change three things
so that Excalidraw runs under the Client's Content Security Policy:

- Excalidraw names its fonts relative to its package and falls back to loading them from a public
  CDN, which the Client's policy refuses. Every font becomes a file of the Client's build, with its
  hash in its name, and the fallback is removed. A font that did not change keeps its address from
  one release to the next, so the service worker never downloads it again. Xiaolai, the handwriting
  font for Chinese, Japanese and Korean (about 13 MB), is not cached when the service worker
  installs: it is fetched the first time a drawing needs it, then kept for use offline.
- Excalidraw cuts fonts down to the characters a picture uses with code that calls `new Function`,
  which the policy refuses. The build makes it embed each font whole instead.
- Excalidraw's stylesheet is scoped (`build-plugins/scope-css.ts`): every rule styles only elements
  with, or inside, a class starting `excalidraw`, so loading it cannot restyle the Client. The
  extension mounts in the page rather than in a shadow root, because Excalidraw's copy and paste and
  its dialogs don't work inside one.

The build checks that each change to Excalidraw's code found the code it changes
(`build-plugins/patches.test.ts` checks the same against the pinned package), so a new Excalidraw
release that moves it fails the build rather than shipping without them. On a development server
the same changes apply to the bundle Vite makes of Excalidraw.

The fonts' licences (SIL Open Font License 1.1, MIT for Comic Shanns, and GPLv2 with Red Hat's font
exceptions for Liberation Sans) are in `build-plugins/FONT-LICENCES.txt`, which the build writes
beside the fonts.

## Licence

Elastic License 2.0, as the Client. Excalidraw is MIT licensed by its authors.
