# The Android signing key

Android installs an update only when it is signed by the key that signed the app already on the device.
A lost key means nobody can be given an update, and a stolen key lets somebody else make one. There is
one key for every channel, and it does not change.

## Create the key (once, by the owner)

On a computer that is not a build server:

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore etherpk-android.p12 -alias etherpk \
    -keyalg RSA -keysize 4096 -validity 18250 -dname "CN=EtherPK, O=App Software Ltd"
```

`keytool` comes with a JDK (`nix-shell apps/android/shell.nix` has one). It asks for a password. Use a
long one from a password manager. The key is good for 50 years.

1. Keep two copies of `etherpk-android.p12` off the computer, in different places, and the password in
   neither of them.
2. Note the certificate's SHA-256, which Google's developer verification asks for:

   ```bash
   keytool -list -v -keystore etherpk-android.p12 -alias etherpk | grep SHA256
   ```

3. Register the package name `com.etherpk.app` with that certificate before the first public APK.
4. If the app goes to Google Play later, choose to use this key as the app signing key. With a key of
   Google's own, a copy from one channel cannot be updated from the other.

## Sign a release

With the key on the same computer:

```bash
export ETHERPK_ANDROID_KEYSTORE=/path/to/etherpk-android.p12
export ETHERPK_ANDROID_KEYSTORE_PASSWORD=…
export ETHERPK_ANDROID_KEY_ALIAS=etherpk           # the default
export ETHERPK_ANDROID_KEY_PASSWORD=…              # the keystore's password unless it is set
./gradlew packageRelease                           # build/release/EtherPK-android.apk and its SHA-256
```

Where the key is kept apart from the build, `./gradlew :app:assembleDirectRelease` with none of these set
makes `app/build/outputs/apk/direct/release/app-direct-release-unsigned.apk`. Sign that file elsewhere:

```bash
zipalign -p -f 4 app-direct-release-unsigned.apk aligned.apk
apksigner sign --ks etherpk-android.p12 --ks-key-alias etherpk --ks-pass env:ETHERPK_ANDROID_KEYSTORE_PASSWORD \
    --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
    --out EtherPK-android.apk aligned.apk
apksigner verify --print-certs EtherPK-android.apk
```

Both tools are in the Android SDK's `build-tools/37.0.0`.
