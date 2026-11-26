#!/usr/bin/env bash
# Installs and starts the Linux packages on a clean Ubuntu 24.04, as a person would:
#
#   scripts/native-apps/smoke-linux.sh <folder of the packages> <version> [folder for screenshots]
#
# It changes the system (a kernel setting, an installed package), so it is for a throwaway machine, and
# it needs sudo, xvfb-run and Node.
set -euo pipefail

packages=$(realpath "$1")
version=$2
shots=${3:-$(mktemp -d)}
mkdir -p "$shots"
here=$(dirname "$(realpath "$0")")

user_namespaces() { # on | off, for a program with no AppArmor profile of its own
    local restricted=0
    [ "$1" = on ] || restricted=1
    sudo sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=$restricted
}

smoke() { # <name> <sandbox on|off> <executable>
    echo "--- $1"
    xvfb-run -a -s '-screen 0 1600x1000x24' node "$here/smoke.mjs" \
        --sandbox "$2" --version "$version" --screenshot "$shots/$1.png" -- "$3"
}

appimage=$packages/EtherPK-linux-x64.AppImage
chmod +x "$appimage"

user_namespaces on
smoke appimage-with-user-namespaces on "$appimage"

# As Ubuntu 24.04 comes. The AppImage has no profile to be let through by, so it starts without
# Chromium's sandbox (and says so), and the installed package brings one, so it keeps the sandbox.
user_namespaces off
smoke appimage-without-user-namespaces off "$appimage"

sudo apt-get install -y -qq "$packages/EtherPK-linux-x64.deb" >/dev/null
[ "$(dpkg-query -W -f '${Version}' etherpk)" = "$version" ]
smoke deb on /opt/EtherPK/etherpk
desktop-file-validate /usr/share/applications/etherpk.desktop || echo "::warning::The desktop entry has faults."
sudo apt-get remove -y -qq etherpk >/dev/null
[ ! -e /opt/EtherPK/etherpk ]
echo 'Both packages start and draw their first page.'
