# The Android SDK, a JDK and (with `--arg emulator true`) an emulator, for building and testing the
# Android app without installing anything on the system:
#
#   nix-shell apps/android/shell.nix --run 'cd apps/android && ./gradlew assembleDirectDebug'
#   nix-shell apps/android/shell.nix --arg emulator true --run '…'
#
# Using the SDK means accepting Google's licence for it. That is done here, for this shell only.
{ emulator ? false
, images ? [ "34" "37.0" ]
, pkgs ? import <nixpkgs> {
    config = {
      android_sdk.accept_license = true;
      allowUnfree = true;
    };
  }
}:
let
  lib = pkgs.lib;
  # One composition per system image: compose's image filter is the product of its lists.
  sdk = (pkgs.androidenv.composeAndroidPackages {
    platformVersions = if emulator then lib.unique ([ "37.0" ] ++ images) else [ "37.0" ];
    buildToolsVersions = [ "36.0.0" "37.0.0" ];
    includeEmulator = emulator;
    includeSystemImages = emulator;
    systemImageTypes = [ "google_apis" ];
    abiVersions = [ "x86_64" ];
    includeNDK = false;
    includeSources = false;
  }).androidsdk;
  jdk = pkgs.jdk21;
in
pkgs.mkShell {
  packages = [ sdk jdk ];
  ANDROID_HOME = "${sdk}/libexec/android-sdk";
  ANDROID_SDK_ROOT = "${sdk}/libexec/android-sdk";
  JAVA_HOME = "${jdk}";
  # Gradle's own copy of aapt2 is a prebuilt binary NixOS cannot run. This one is patched.
  GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/libexec/android-sdk/build-tools/37.0.0/aapt2";
  # The emulator and adb are on the PATH of a session that has another session's adb server on the
  # default port. Keep to our own, so a phone somebody plugged in is never reached.
  ANDROID_ADB_SERVER_PORT = "5437";
}
