param(
    [Parameter(Mandatory = $true)]
    [string]$LumiverseDataDirectory
)
$ErrorActionPreference = 'Stop'
$dataPath = (Resolve-Path -LiteralPath $LumiverseDataDirectory).Path
if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
    throw 'LumiverseDataDirectory must be an existing data directory.'
}
$extensionsPath = Join-Path $dataPath 'extensions'
$destinationPath = Join-Path $extensionsPath 'lumivoice'
$sourcePath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
if ($destinationPath.StartsWith($sourcePath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose your Lumiverse data directory outside the extracted extension folder.'
}
if (Test-Path -LiteralPath $destinationPath) {
    throw "Destination already exists: $destinationPath. This helper does not overwrite an installed extension."
}
New-Item -ItemType Directory -Path $extensionsPath -Force | Out-Null
Copy-Item -LiteralPath $PSScriptRoot -Destination $destinationPath -Recurse
Write-Host "Copied Lumivoice to $destinationPath"
Write-Host 'Next: Lumiverse > Extensions > Add > Import local, then enable Lumivoice.'
