[CmdletBinding()]
param(
    [string]$ShortcutName = "StickBlade RPG",
    [string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'

if (-not $RepositoryRoot) {
    $RepositoryRoot = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
}

$DesktopPath = [Environment]::GetFolderPath('Desktop')
if (-not $DesktopPath -or -not (Test-Path -LiteralPath $DesktopPath)) {
    throw "Could not locate Desktop directory."
}

$IconPath = Join-Path $RepositoryRoot "ASSETS\icon\StickBlade_Icon.ico"
if (-not (Test-Path -LiteralPath $IconPath)) {
    Write-Host "Generating StickBlade icon..."
    & node (Join-Path $RepositoryRoot "scripts\generate-stickblade-icon.mjs")
}

$ShortcutPath = Join-Path $DesktopPath "$ShortcutName.lnk"

# Use powershell.exe with -WindowStyle Hidden so double-clicking launches Electron cleanly without leaving a persistent console window.
$TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""Set-Location -LiteralPath '$RepositoryRoot'; npm run desktop"""

$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $RepositoryRoot
$Shortcut.IconLocation = "$IconPath,0"
$Shortcut.Description = "Launch StickBlade RPG in Electron"
$Shortcut.Save()

Write-Host "Desktop shortcut created successfully at '$ShortcutPath'."
