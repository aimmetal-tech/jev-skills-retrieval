param(
    [Parameter(Mandatory = $true)][string]$Output,
    [string]$Session = 'skillret-full',
    [string]$Namespace = 'jev-benchmark',
    [switch]$Resume,
    [switch]$Inside
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = Split-Path -Parent $PSScriptRoot
$benchmarkRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'outputs/benchmark'))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $benchmarkRoot $Output))
if (-not $outputRoot.StartsWith($benchmarkRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output must be inside outputs/benchmark.'
}
Set-Location -LiteralPath $projectRoot
if (-not $Inside) {
    Get-Command psmux -ErrorAction Stop | Out-Null
    & psmux -L $Namespace has-session -t $Session 2>$null
    if ($LASTEXITCODE -eq 0) { throw 'The requested psmux session already exists; inspect it before launching another run.' }
    if (-not $Resume -and (Test-Path -LiteralPath $outputRoot)) { throw 'Fresh runs require a new output directory.' }
    $arguments = @('new-session', '-d', '-s', $Session, '-c', $projectRoot, '--', 'pwsh', '-NoLogo', '-NoProfile', '-NoExit', '-File', $PSCommandPath, '-Output', $Output, '-Session', $Session, '-Namespace', $Namespace, '-Inside')
    if ($Resume) { $arguments += '-Resume' }
    & psmux -L $Namespace @arguments
    if ($LASTEXITCODE -ne 0) { throw 'psmux could not start the benchmark session.' }
    Write-Output "Attach: psmux -L $Namespace attach -t $Session"
    exit 0
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$encoding = [Text.UTF8Encoding]::new($false)
$sessionInfo = @{ schemaVersion = 2; namespace = $Namespace; session = $Session; output = $Output; resume = [bool]$Resume; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); powershellPid = $PID; oldResultsImported = $false }
[IO.File]::WriteAllText((Join-Path $outputRoot 'psmux-session.json'), ($sessionInfo | ConvertTo-Json), $encoding)
$nodeArgs = @('--import', 'tsx', 'benchmark/run.ts', '--live', '--suite', 'skillret', '--output', $Output, '--continue-unknown-usage', '--max-requests', '700000', '--max-total-tokens', '100000000000', '--max-turns', '12', '--max-output-tokens', '4096', '--task-timeout-ms', '720000')
if ($Resume) { $nodeArgs += '--resume' }
Write-Output "Fresh independent evidence: $Output"
Write-Output 'Model: Pi OpenAI OAuth gpt-6-luna / medium; Jev concurrency 1.'
Write-Output 'Unknown costs remain unknown. Recovery retries are bounded and recorded.'
$PSNativeCommandUseErrorActionPreference = $false
& node @nodeArgs 2>&1 | Tee-Object -FilePath (Join-Path $outputRoot 'psmux-console.log') -Append
$nodeExit = $LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $outputRoot 'psmux-exit.json'), (@{ exitCode = $nodeExit; finishedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json), $encoding)
Write-Output "Benchmark process exited with code $nodeExit. Evidence: $outputRoot"
Write-Output 'This pane remains open. Inspect the recorded state before resuming.'
