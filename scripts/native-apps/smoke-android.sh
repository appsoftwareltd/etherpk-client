#!/usr/bin/env bash
# Checks the APK that will be released, and starts it on the emulator that is running, if there is one:
#
#   scripts/native-apps/smoke-android.sh <apk> <version> <SHA-256 of the signing certificate> [--boot]
#
# It needs the Android SDK (ANDROID_HOME).
set -euo pipefail

apk=$(realpath "$1")
version=$2
certificate=$(echo "$3" | tr -d ': ' | tr '[:upper:]' '[:lower:]')
package=com.etherpk.app
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 | sort -V | tail -n 1)

fail() { echo "::error::$1"; exit 1; }

# The one certificate, and no other: an APK signed with another key installs over no EtherPK there is.
signed=$("$tools/apksigner" verify --verbose --print-certs --min-sdk-version 30 "$apk")
digests=$(sed -nE 's/^(V[0-9.]+ )?[Ss]igner.*certificate SHA-256 digest: ([0-9a-f]+)$/\2/p' <<<"$signed" | sort -u)
[ "$digests" = "$certificate" ] || fail "The APK is signed with $digests, not with $certificate."
grep -Eq 'Verified using v1 scheme \(JAR signing\): false' <<<"$signed" || fail 'The APK has a v1 signature.'
# Android 11, the oldest the app runs on, reads v3.
grep -Eq 'Verified using v3 scheme \(APK Signature Scheme v3\): true' <<<"$signed" || fail 'The APK has no v3 signature.'
"$tools/zipalign" -c -P 16 4 "$apk" || fail 'The APK is not aligned.'

badging=$("$tools/aapt2" dump badging "$apk")
grep -q "^package: name='$package' .*versionName='$version'" <<<"$badging" || fail "The APK is not $package $version."
grep -Eq "^(minSdkVersion|sdkVersion):'30'" <<<"$badging" || fail 'The APK is not for Android 11 and later.'
if grep -q 'application-debuggable' <<<"$badging"; then fail 'The APK is debuggable.'; fi
echo "The APK is $package $version, signed with the expected certificate."
[ "${4:-}" = --boot ] || exit 0

adb install --no-incremental -r "$apk"
adb logcat -c
adb shell am start -W -n "$package/.MainActivity"
for _ in $(seq 1 60); do
    # The page's words reach the accessibility tree, which is what uiautomator reads.
    adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
    window=$(adb shell cat /sdcard/window.xml 2>/dev/null || true)
    if grep -q 'Create a Folder Graph\|Choose a folder' <<<"$window"; then
        echo 'The app starts and draws its first page.'
        adb exec-out screencap -p > smoke-android.png
        exit 0
    fi
    sleep 2
done
echo "--- the app's process: $(adb shell pidof "$package" || echo 'not running')"
echo '--- crashes'
adb logcat -d -b crash | tail -n 60
adb logcat -d > smoke-android.log
echo '--- what the app logged (all of it is in smoke-android.log)'
grep -iE "$package|AndroidRuntime|chromium|cr_|WebView|ActivityTaskManager|ActivityManager" smoke-android.log | grep -v uiautomator | sed -n 1,80p || true
adb exec-out screencap -p > smoke-android.png
fail 'The app did not draw its first page.'
