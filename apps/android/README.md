# EtherPK for Android

A small Kotlin app around a WebView: the Native App for Android. The page is the Client's Installed Build, in the APK, answered at
`https://installed.app.etherpk.com` with nothing fetched from that address. What the system does for the
page goes through the Native Bridge (`packages/native-bridge`).

## Build

```bash
pnpm --filter @appsoftwareltd/etherpk-client build:installed
nix-shell apps/android/shell.nix --run 'cd apps/android && ./gradlew assembleDirectDebug'
```

Without Nix: a JDK 21, and an Android SDK with platform 37 and build-tools 37.0.0 at `ANDROID_HOME`.

| Task | Does |
| --- | --- |
| `:app:testDirectDebugUnitTest` | The unit tests, the port's contract over this computer's disk among them |
| `:app:lintDirectDebug` | Android lint. A warning fails it |
| `:app:connectedDirectDebugAndroidTest` | The tests on a device or an emulator, which installs `testapp` too |
| `:app:assembleDirectRelease` | The release APK, unsigned without a key |
| `packageRelease` | The signed `build/release/EtherPK-android.apk` ([SIGNING.md](SIGNING.md)) |

`-PinstalledBuild=<folder>` packs another Installed Build. The version is `apps/client/package.json`'s.

| Build-time setting | What it does |
| --- | --- |
| `INSTALLED_ACCOUNT_ISSUER` | The account site to sign in to. Set it when you make the Installed Build: Gradle reads it from the build's `installed-settings.json`. Unset, the app has no sign-in |
| `INSTALLED_UPDATE_FEED_URL` | The signed list of releases. Unset, or with no key in `apps/desktop/update-keys.json`, the app does not check |
| `ETHERPK_ANDROID_*` | The signing key ([SIGNING.md](SIGNING.md)) |

A published APK opens with Managed Sync. The Android app has no run-time setting for another Sync
Server, as the desktop app has (`ETHERPK_SYNC_SERVER`, ADR 0214): Android apps have no environment. A
person adds their organisation's server on the Graphs page's **Sync** tab, with the address and access
token the organisation gives them: **Use your own Sync Server** on a device with no Sync Server yet, or
**Add a Sync Server**, then **Custom server**, beside Managed Sync. Android Enterprise managed
configuration could carry the same setting later, for organisations that manage their phones.

## The two builds

`direct` is what a person downloads. `play` is for a store, which allows neither of the two things it
leaves out: the check for a newer release, and All files access.

A folder is chosen in Android's own dialog in both, and reached through the document provider that
dialog gives. In the direct build the person can also turn on **All files access**, off until then, and
the app reaches the same folders by path: faster, a file replaced in one step, and changes other
programs make reported. The explanation and the button to Android's switch are under **Folder access**:
hold the app's icon, or open the app's page in Android's settings. The app never asks by itself.

## Where things are

In `app/src/main/kotlin/com/etherpk/app`:

| | |
| --- | --- |
| `bridge/` | The port: frames, calls, the table of methods. `res/raw/port.js` is the page's end |
| `folders/` | Chosen folders: by path (`DirectFolder`), through a provider (`SafFolder`), the watch |
| `files/` | Shared and opened files, the save dialog, what the system handed over |
| `auth/` | Signing in: the requests, the rules for the refresh token, where it is kept |
| `update/` | The signed list of releases |
| `web/` | Answering the app's own host, and the WebView's settings |
| `MainActivity`, `Shell` | The one screen, and everything that outlasts it |

`app/src/sharedTest` is the port's contract (`packages/native-bridge/src/contract.ts`) in Kotlin. It runs
on the JVM over a directory, and on a device over shared storage by path and through its provider, and
over the provider in `testapp`, with and without moves. `AppTest.a1_…` drives the folder dialog and grants
the folder that `SafStorageContractTest` uses, so run the whole suite rather than that class alone.

## What the page may reach

- The port is on documents of the app's own origin, in the main frame. Every other frame's messages are
  dropped, and a method outside the table is refused.
- A folder or a file is a random id. A path is relative, checked by its parts, and by where it leads on
  the disk.
- Bytes too large for one message are fetched from `/__native/bytes/<token>`: a token of 256 random bits,
  given to the page alone, used once and dropped after a minute. The path in the address is never a path.
- Another app's share is copied at once under names of this app's own, up to 50 files and 200 MB.
