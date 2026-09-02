param([Parameter(Mandatory=$true)][string]$Binary)

$installDir = Join-Path $env:LOCALAPPDATA "Drake Speech\bin"
$target = Join-Path $installDir "drake-speech-service.exe"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force $Binary $target
$taskName = "Drake Speech Service"
schtasks.exe /Create /F /SC ONLOGON /TN $taskName /TR ('"' + $target + '"') | Out-Null
Start-Process -FilePath $target
