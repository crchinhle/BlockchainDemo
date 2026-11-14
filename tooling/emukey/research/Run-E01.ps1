param([string]$Directory, [switch]$Foreground, [switch]$Status)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if (-not $Directory) { $Directory=Join-Path $repo ('EmuKey/backend/.research-local/evidence/EmuKey_E01_'+(Get-Date -Format 'yyyyMMdd-HHmmss')) }
$Directory=[System.IO.Path]::GetFullPath($Directory)
if ($Status) { $m=Get-Content (Join-Path $Directory 'manifest.json') -Raw | ConvertFrom-Json; if (-not $m.status) { Write-Output 'Status: RUNNING (inspect last attempt and process log)' } else { $m | Select-Object status,error | Format-List }; $m.attempts | Group-Object group,smoke,state | Select-Object Name,Count | Format-Table -AutoSize; return }
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
Push-Location $repo
try {
 if (-not $Foreground) {
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
  $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Directory',('"'+$Directory+'"'),'-Foreground')
  $p=Start-Process powershell -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Directory "supervisor-$stamp.log") -RedirectStandardError (Join-Path $Directory "supervisor-$stamp.err.log") -PassThru
  Write-Output "Background PID: $($p.Id)";Write-Output "Directory: $Directory";return
 }
 function Test-Port([int]$Port) { $c=New-Object Net.Sockets.TcpClient;try {$c.Connect('127.0.0.1',$Port);return $true} catch {return $false} finally {$c.Dispose()} }
 if (-not (Test-Port 3100)) {
  if ((Test-Port 58545) -or (Test-Port 5174)) { throw 'Partial services detected. Restore the API with RESEARCH_DECISION_TRACE=1 before resuming; do not create a second chain.' }
  docker info --format '{{.ServerVersion}}' | Out-Null
  if ($LASTEXITCODE -ne 0) {
   Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -WindowStyle Hidden
   for($i=0;$i -lt 60;$i++){Start-Sleep -Seconds 2;docker info --format '{{.ServerVersion}}' 2>$null | Out-Null;if($LASTEXITCODE -eq 0){break}}
   if($LASTEXITCODE -ne 0){throw 'Docker startup unavailable; resume after Docker becomes ready.'}
  }
  corepack pnpm --dir EmuKey/backend/contracts build
  if($LASTEXITCODE -ne 0){throw 'Contract build failed'}
  corepack pnpm --dir EmuKey/backend build
  if($LASTEXITCODE -ne 0){throw 'Backend build failed'}
  $env:RESEARCH_DECISION_TRACE='1'
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
  Start-Process -FilePath (Get-Command node).Source -ArgumentList 'EmuKey/scripts/research-local.mjs' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "EmuKey/backend/.research-local/followup-runtime-$stamp.log" -RedirectStandardError "EmuKey/backend/.research-local/followup-runtime-$stamp.err.log"
  for($i=0;$i -lt 200 -and -not(Test-Port 3100);$i++){Start-Sleep -Milliseconds 500}
  if(-not(Test-Port 3100)){throw 'Research API not ready; runtime log retained.'}
 }
 node tooling/emukey/research/e01-run.mjs $Directory
 if ($LASTEXITCODE -ne 0) { throw 'Measurement blocked; inspect manifest and logs. Resume uses the same Directory.' }
 & EmuKey/backend/.research-local/python/Scripts/python.exe tooling/emukey/research/analyze-e01.py $Directory
 if ($LASTEXITCODE -ne 0) { throw 'Analysis failed.' }
 & EmuKey/backend/.research-local/python/Scripts/python.exe tooling/emukey/research/package-e01.py $Directory
 if ($LASTEXITCODE -ne 0) { throw 'ZIP verification failed.' }
} finally { Pop-Location }
