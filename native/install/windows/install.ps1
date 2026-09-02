param([Parameter(Mandatory=$true)][string]$Binary)

$installDir = Join-Path $env:LOCALAPPDATA "Drake Speech\bin"
$target = Join-Path $installDir "drake-speech-service.exe"
$nativeDir = Resolve-Path (Join-Path $PSScriptRoot "..\..")
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force $Binary $target
Copy-Item -Force (Join-Path $nativeDir "..\LICENSE") (Join-Path $installDir "LICENSE")
Copy-Item -Force (Join-Path $nativeDir "..\NOTICE.md") (Join-Path $installDir "NOTICE.md")
Copy-Item -Force (Join-Path $nativeDir "THIRD-PARTY-LICENSES.txt") (Join-Path $installDir "THIRD-PARTY-LICENSES.txt")
$taskName = "Drake Speech Service"
schtasks.exe /Create /F /SC ONLOGON /TN $taskName /TR ('"' + $target + '"') | Out-Null
Start-Process -FilePath $target
