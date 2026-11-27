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

# The system's display service and its server, by process id. Either one changing while the app starts
# means the emulator's own system restarted, which no APK causes.
system_processes() { echo "surfaceflinger $(adb shell pidof surfaceflinger || echo none), system_server $(adb shell pidof system_server || echo none)"; }

# A picture of the screen, kept only when the device gave one.
screenshot() {
    adb exec-out screencap -p > smoke-android.png 2>/dev/null || true
    [ "$(head -c 4 smoke-android.png | tail -c 3)" = PNG ] || rm -f smoke-android.png
}

# The window in front, as uiautomator reads it: the words of a page reach the accessibility tree.
look() {
    adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
    window=$(adb shell cat /sdcard/window.xml 2>/dev/null || true)
}

# A slow emulator's own parts can stop answering, and Android then puts a dialog in front of everything,
# which is the window uiautomator reads. The app's own is a failure. Any other is told to wait.
past_a_stall() {
    local stalled left top right bottom
    stalled=$(grep -oE 'text="[^"]* isn(&apos;|'"'"')t responding"' <<<"$window" | head -n 1 | sed -E 's/^text="(.*) isn.*$/\1/' || true)
    [ -n "$stalled" ] || return 0
    if grep -qi etherpk <<<"$stalled"; then screenshot; fail 'The app stopped responding as it started.'; fi
    echo "The emulator's $stalled stopped responding. Choosing Wait."
    read -r left top right bottom <<<"$(grep -oE 'text="Wait"[^>]*bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' <<<"$window" | head -n 1 | grep -oE '[0-9]+' | tr '\n' ' ' || true)" || true
    if [ -n "${bottom:-}" ]; then adb shell input tap $(((left + right) / 2)) $(((top + bottom) / 2)); fi
}

# The home screen first, so that the app's first frame is not the device's first too. A boot is
# reported complete before the launcher has drawn.
for _ in $(seq 1 90); do
    focus=$(adb shell dumpsys window 2>/dev/null | grep -m 1 mCurrentFocus || true)
    grep -qi launcher <<<"$focus" && break
    look
    past_a_stall
    sleep 2
done
grep -qi launcher <<<"$focus" || fail "The emulator's home screen did not come up within three minutes. In front: ${focus:-nothing}."
before=$(system_processes)

# The emulator's fault is told apart from the app's: four releases were held back by the first. The
# log is the whole of it since the boot, since the system can stop before the app is asked for.
emulator_fault() {
    local after stopped
    after=$(system_processes)
    adb logcat -d > smoke-android.log 2>/dev/null || true
    stopped=$(grep -E 'Fatal signal .* pid [0-9]+ \((surfaceflinger|system_server)\)' smoke-android.log | sed -n 1,3p || true)
    [ "$before" != "$after" ] || [ -n "$stopped" ] || return 0
    echo '--- what stopped the system'
    echo "$stopped"
    grep -E 'Abort message' smoke-android.log | sed -n 1,3p || true
    [ "$before" = "$after" ] || echo "It was $before, and is $after."
    fail "The emulator's own system stopped while the app was installed and started, so nothing could draw. The fault is in the emulator, not in the APK."
}

adb install --no-incremental -r "$apk" || { emulator_fault; fail 'The APK did not install.'; }
started=$(adb shell am start -W -n "$package/.MainActivity" 2>&1) || true
echo "$started"
if ! grep -q '^Status: ok' <<<"$started"; then emulator_fault; fail 'The app did not start.'; fi
for _ in $(seq 1 60); do
    look
    if grep -q 'Create a Folder Graph\|Choose a folder' <<<"$window"; then
        echo 'The app starts and draws its first page.'
        screenshot
        exit 0
    fi
    past_a_stall
    sleep 2
done
adb logcat -d > smoke-android.log
echo "--- the app's process: $(adb shell pidof "$package" || echo 'not running')"
echo '--- crashes'
adb logcat -d -b crash | tail -n 60
echo '--- what the app logged (all of it is in smoke-android.log)'
grep -iE "$package|AndroidRuntime|chromium|cr_|WebView|ActivityTaskManager|ActivityManager" smoke-android.log | grep -v uiautomator | sed -n 1,80p || true
screenshot
emulator_fault
fail 'The app did not draw its first page.'
