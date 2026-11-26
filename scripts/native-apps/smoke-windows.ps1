# Installs the Windows installer silently for this account, starts the app, and uninstalls it:
#
#   scripts/native-apps/smoke-windows.ps1 <installer.exe> <version>
#
# For a throwaway machine. It needs Node.
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
$uninstallKeys = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\*'

function Get-Installed([string]$hive) {
    Get-ItemProperty "${hive}:\$uninstallKeys" -ErrorAction SilentlyContinue |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'EtherPK*' }
}

function Wait-Until([string]$what, [scriptblock]$met) {
    for ($i = 0; $i -lt 120; $i++) {
        if (& $met) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Waited too long for $what."
}

if (Get-Installed 'HKCU') { throw 'EtherPK is installed already.' }
$setup = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList '/S' -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "The installer ended with $($setup.ExitCode)." }
Wait-Until 'the app to be listed as installed' { Get-Installed 'HKCU' }

$entry = Get-Installed 'HKCU'
if ($entry.DisplayVersion -ne $Version) { throw "Windows lists version $($entry.DisplayVersion), not $Version." }
# For this account only: listed nowhere for every account, and in no folder of theirs.
if (Get-Installed 'HKLM') { throw 'The app was installed for every account.' }
$uninstaller = [regex]::Match($entry.UninstallString, '^"([^"]+)"').Groups[1].Value
$folder = Split-Path $uninstaller
if (-not $folder.StartsWith($env:LOCALAPPDATA)) { throw "The app was installed in $folder." }
$app = Join-Path $folder 'EtherPK.exe'

# A silent install starts nothing by itself. One left running would be the window the next start opens.
Get-Process 'EtherPK' -ErrorAction SilentlyContinue | Stop-Process -Force
node (Join-Path $PSScriptRoot 'smoke.mjs') --version $Version --screenshot smoke-windows.png -- $app
if ($LASTEXITCODE -ne 0) { throw 'The app did not draw its first page.' }
Get-Process 'EtherPK' -ErrorAction SilentlyContinue | Stop-Process -Force

if (-not (Test-Path 'HKCU:\Software\Classes\etherpk\shell\open\command')) { throw 'etherpk: links are not registered.' }
# The uninstaller goes on in a copy of itself, so what is waited for is what it leaves.
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
Wait-Until 'the app to be gone' { -not (Test-Path $app) -and -not (Get-Installed 'HKCU') }
if (Test-Path 'HKCU:\Software\Classes\etherpk') { throw 'The uninstaller left the etherpk: link behind.' }
Write-Output 'The installer installs, starts and uninstalls for this account.'
