param([Parameter(Mandatory=$true)][string]$Output,[switch]$Resume)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$benchmarkRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot 'outputs/benchmark'))
$pipelineRoot=[IO.Path]::GetFullPath((Join-Path $benchmarkRoot $Output))
if(-not $pipelineRoot.StartsWith($benchmarkRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Output must be under outputs/benchmark.'}
if(-not $Resume -and (Test-Path -LiteralPath $pipelineRoot)){throw 'A fresh pipeline requires a new directory.'}
if($Resume -and -not(Test-Path -LiteralPath (Join-Path $pipelineRoot 'pipeline.json'))){throw 'Resume requires an existing pipeline manifest.'}
Get-Command psmux -ErrorAction Stop | Out-Null
$launchRoot=Join-Path $benchmarkRoot 'launch-logs'
New-Item -ItemType Directory -Path $launchRoot -Force | Out-Null
$stamp=[DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
$nodePath=(Get-Command node -ErrorAction Stop).Source
$nodeArgs=@('--import','tsx',('"'+(Join-Path $projectRoot 'benchmark/parallel/pipeline.ts')+'"'),'--live','--output',('"'+$Output+'"'))
if($Resume){$nodeArgs+='--resume'}
$process=Start-Process -FilePath $nodePath -ArgumentList $nodeArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $launchRoot "$stamp.stdout.log") -RedirectStandardError (Join-Path $launchRoot "$stamp.stderr.log") -PassThru
Write-Output "Coordinator PID: $($process.Id)"
Write-Output "Fresh pipeline: $pipelineRoot"
Write-Output "Launch logs: $launchRoot/$stamp.*.log"
