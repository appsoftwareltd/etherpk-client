# EtherPK for NixOS: the release's .deb, its Electron patched to find its libraries in the Nix store.
#
# Each GitHub Release attaches a copy of this file as EtherPK-linux-x64.nix, with `version` and
# `hash` set to that release's .deb (scripts/native-apps/nix-package.mjs). The values below are
# those of the release this file was last tested against, so take the release's copy to install.
#
#   nix-build -E 'with import <nixpkgs> { config.allowUnfree = true; }; callPackage ./package.nix { }'
#
# The app updates itself only as an AppImage or from /opt/EtherPK. Run from the store it offers no
# updates, and Nix updates it.
{
  lib,
  stdenv,
  fetchurl,
  dpkg,
  autoPatchelfHook,
  makeWrapper,
  wrapGAppsHook3,
  nix-update-script,
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  cairo,
  cups,
  dbus,
  expat,
  glib,
  gtk3,
  libdrm,
  libgbm,
  libGL,
  libnotify,
  libpulseaudio,
  libsecret,
  libuuid,
  libx11,
  libxcb,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxkbcommon,
  libxrandr,
  libxshmfence,
  nspr,
  nss,
  pango,
  systemd,
  xdg-utils,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "etherpk";
  version = "1.0.1";

  # The installers' names carry no version. The release's tag does.
  src = fetchurl {
    url = "https://github.com/appsoftwareltd/etherpk-client/releases/download/v${finalAttrs.version}/EtherPK-linux-x64.deb";
    hash = "sha256-50EAln4PVaM8P318ddO0O+4s4mNa3CqiJv+L+d55Wzg=";
  };

  nativeBuildInputs = [
    dpkg
    autoPatchelfHook
    makeWrapper
    wrapGAppsHook3
  ];

  buildInputs = [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    cairo
    cups
    dbus
    expat
    glib
    gtk3
    libdrm
    libgbm
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxkbcommon
    libxrandr
    libxshmfence
    nspr
    nss
    pango
  ];

  # Chromium opens these while it runs, so no ELF header names them and autoPatchelfHook would not
  # find them on its own.
  runtimeDependencies = [
    (lib.getLib systemd) # libudev: devices
    libGL
    libnotify
    libpulseaudio
    libsecret # the system's key store, where the app keeps its sign-in
    libuuid
  ];

  unpackPhase = ''
    runHook preUnpack
    dpkg-deb --fsys-tarfile $src | tar -x --no-same-owner --no-same-permissions
    runHook postUnpack
  '';

  # The one wrapper is made below, with the GTK settings and the flags together.
  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/lib
    cp -r opt/EtherPK $out/lib/etherpk
    cp -r usr/share $out/share

    # A file in the store cannot be setuid. NixOS lets programs make user namespaces, and Chromium's
    # sandbox uses them instead of this helper.
    rm $out/lib/etherpk/chrome-sandbox
    # Ubuntu's AppArmor profile, for /opt/EtherPK.
    rm $out/lib/etherpk/resources/apparmor-profile

    substituteInPlace $out/share/applications/etherpk.desktop \
      --replace-fail "Exec=/opt/EtherPK/etherpk" "Exec=etherpk"

    runHook postInstall
  '';

  # xdg-open takes sign-in and links to the system's browser.
  postFixup = ''
    makeWrapper $out/lib/etherpk/etherpk $out/bin/etherpk \
      "''${gappsWrapperArgs[@]}" \
      --prefix PATH : ${lib.makeBinPath [ xdg-utils ]} \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-wayland-ime=true}}"
  '';

  passthru.updateScript = nix-update-script { };

  meta = {
    description = "Notes, journals and tasks, in a folder of your own or encrypted and synced";
    homepage = "https://etherpk.com";
    changelog = "https://github.com/appsoftwareltd/etherpk-client/blob/v${finalAttrs.version}/CHANGELOG.md";
    license = lib.licenses.elastic20;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
    mainProgram = "etherpk";
  };
})
