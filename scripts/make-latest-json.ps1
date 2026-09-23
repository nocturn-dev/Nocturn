# Generates latest.json for the tauri-plugin-updater from the NSIS .sig file.
# Usage: pwsh make-latest-json.ps1 -BundleDir <bundle dir> -Tag <vX.Y.Z> -Repo <owner/repo> -Out <out path>
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

$sig = Get-ChildItem -Path (Join-Path $BundleDir "nsis") -Filter "*.exe.sig" | Select-Object -First 1
if (-not $sig) { throw "no .sig file found under $(Join-Path $BundleDir 'nsis')" }

$version = $Tag.TrimStart("v")
$exeName = $sig.Name.Substring(0, $sig.Name.Length - ".sig".Length)
$signature = (Get-Content $sig.FullName -Raw).Trim()

$payload = [ordered]@{
  version  = $version
  notes    = "Release $Tag"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url = "https://github.com/$Repo/releases/download/$Tag/$exeName"
    }
  }
}

$json = $payload | ConvertTo-Json -Depth 5
Set-Content -Path $Out -Value $json -Encoding utf8
Write-Host "latest.json written to $Out"
Write-Host $json
