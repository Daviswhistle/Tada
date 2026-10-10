[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Report)
$ErrorActionPreference = 'Stop'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('tada-install-safety-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $source = Split-Path -Parent $PSScriptRoot
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  $binary = Join-Path $temporary 'safety.exe'
  & $compiler /nologo /warnaserror+ /target:exe /platform:x64 /reference:Microsoft.CSharp.dll "/out:$binary" (Join-Path $PSScriptRoot 'windows-installation-safety.cs') (Join-Path $source 'apps/windows/InstalledApp.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }
  $result = & $binary $temporary
  if ($LASTEXITCODE -ne 0) { throw 'Installation safety failed' }
  $result | Set-Content -LiteralPath $Report -Encoding UTF8
  Write-Output $result
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
