# EtherPK Extension API

The types an [EtherPK](https://etherpk.com) extension is written against, and the function that
checks an extension's manifest the way the EtherPK Client does. MIT licensed.

An extension is an npm package. Its package.json carries an `etherpk` manifest, and its main
module exports `activate(context)`, which the Client calls as each graph opens:

```ts
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

export function activate(context: ExtensionContext): void {
    context.commands.register('hello.greet', () => context.notify('Hello from an extension.'))
}
```

```json
{
    "name": "etherpk-extension-hello",
    "version": "1.0.0",
    "etherpk": {
        "id": "hello",
        "displayName": "Hello",
        "publisher": "You",
        "minClientVersion": "0.8.54",
        "main": "./dist/main.js"
    }
}
```

Everything here is Proposed (`@beta` in the type declarations) and may change in any release until
extensions from other publishers can be installed. From then on, a Stable declaration (`@public`)
never breaks. `etc/` holds the API reports CI checks every change against.

## Settings

A value the person sets, such as a key for a service, is declared in the manifest, and the Client
draws it under the extension's entry in Settings and Extensions → Extensions:

```json
"settings": [
    {
        "id": "api-key",
        "type": "secret",
        "title": "Weather service key",
        "description": "Forecasts come from your own account with the weather service.",
        "placeholder": "wk_…",
        "link": { "title": "Getting a key", "url": "https://weather.example.com/keys" }
    }
]
```

`type` is `text` or `secret`, and a secret stays masked until the person shows it. The person can
set them while the extension is switched off. The extension reads the value with
`context.settings.get('api-key')`, which is undefined until it is set, and hears every change with
`context.settings.subscribe`. Settings belong to the person rather than a graph. Where their
account syncs a graph, they follow the person to their other devices, encrypted so only those
devices can read them.

## Writing to the page

The Client enforces [Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API),
and extension code runs under it:

- **An extension cannot create a Trusted Types policy.** The Client's Content Security Policy names
  the policies it allows, and each belongs to the Client or a library it ships.
- **Write no HTML.** Build elements with the DOM (`createElement`, `createElementNS`,
  `textContent`). A string written to an HTML sink such as `innerHTML` is sanitized by the Client's
  default policy, which may remove what you wrote.
- **Draw icons with `context.icons.svg`.** It returns `IconMarkup`, which Svelte's `{@html}` takes
  as it is. The icons your manifest adds are sanitized as SVG before they are drawn, so they can
  hold only SVG.
