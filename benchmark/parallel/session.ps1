param([Parameter(Mandatory=$true)][string]$Pipeline,[Parameter(Mandatory=$true)][ValidateSet('native','router')][string]$Group)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$projectRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $projectRoot
Write-Output "Independent parallel worker: $Group"
Write-Output "Evidence: $Pipeline"
Write-Output 'Per-group concurrency comes from the frozen stage manifest. OpenAI account peaks are 6 or 10.'
& node --import tsx benchmark/parallel/worker.ts --pipeline $Pipeline --group $Group 2>&1 | Tee-Object -FilePath (Join-Path $Pipeline "console-$Group.log") -Append
$workerExit=$LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $Pipeline "exit-$Group.json"),(@{exitCode=$workerExit;finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output "Worker exited: $workerExit. The pane remains available; inspect coordinator state."
