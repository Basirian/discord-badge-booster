$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot 'dist\BadgeBooster.exe'
$workerPath = Join-Path $projectRoot 'dist\Placeholder.exe'
if (-not (Test-Path -LiteralPath $launcherPath)) { throw 'Run build.ps1 first.' }
$assembly = [Reflection.Assembly]::LoadFile($launcherPath)
$catalog = [LocalFiles]::ReadCatalog()
$testDirectory = Join-Path $PSScriptRoot ('output\' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null

function Assert-True($condition, [string]$message) {
    if (-not $condition) { throw "FAIL: $message" }
}

Assert-True ($catalog.games.Count -gt 100) 'Embedded catalog loads.'
foreach ($game in $catalog.games) {
    foreach ($entry in $game.executables) {
        $null = [LocalFiles]::SafePath($testDirectory, $game.id, $entry.path)
    }
}
Write-Output "PASS: $($catalog.games.Count) embedded games and all executable paths validated."

foreach ($unsafe in @('../escape.exe', 'x/../../escape.exe', 'C:\escape.exe', '\\server\share\escape.exe', 'x.exe:stream', 'con.exe', 'x/aux.exe', 'x./game.exe', 'x /game.exe', '/absolute.exe', 'x.txt')) {
    $rejected = $false
    try { $null = [LocalFiles]::SafePath($testDirectory, '12345', $unsafe) } catch { $rejected = $true }
    Assert-True $rejected "Unsafe path rejected: $unsafe"
}
$rejected = $false
try { $null = [LocalFiles]::SafePath($testDirectory, '../123', 'safe.exe') } catch { $rejected = $true }
Assert-True $rejected 'Unsafe game ID rejected.'
Write-Output 'PASS: Absolute paths, traversal, alternate streams, device names, and non-executables rejected.'

$neutralPath = Join-Path $testDirectory 'LocalPlaceholderVerification.exe'
[LocalFiles]::WritePlaceholder($neutralPath)
Assert-True ((Get-FileHash -LiteralPath $neutralPath).Hash -eq (Get-FileHash -LiteralPath $workerPath).Hash) 'Embedded worker matches the locally built worker.'
[LocalFiles]::WritePlaceholder($neutralPath)
$conflictPath = Join-Path $testDirectory 'ExistingFile.exe'
[IO.File]::WriteAllText($conflictPath, 'keep this file')
$rejected = $false
try { [LocalFiles]::WritePlaceholder($conflictPath) } catch { $rejected = $true }
Assert-True ($rejected -and [IO.File]::ReadAllText($conflictPath) -eq 'keep this file') 'Existing different files are preserved.'
Write-Output 'PASS: Embedded worker integrity and overwrite protection.'

$selfProcess = [Diagnostics.Process]::GetCurrentProcess()
$encodedTitle = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('Neutral verification - no game activity'))
$workerArguments = "--local-parent $PID --local-parent-start $($selfProcess.StartTime.ToUniversalTime().Ticks) --local-title $encodedTitle"
$worker = $null
$parent = $null
$orphan = $null
try {
    $worker = Start-Process -FilePath $neutralPath -ArgumentList $workerArguments -PassThru -WindowStyle Hidden
    $null = $worker.WaitForInputIdle(5000)
    Start-Sleep -Milliseconds 400
    Assert-True (-not $worker.HasExited) 'Worker stays alive with its real parent.'
    $worker.Refresh()
    Assert-True ($worker.MainWindowHandle -ne [IntPtr]::Zero) 'Worker provides a closeable window.'
    $null = $worker.CloseMainWindow()
    Assert-True ($worker.WaitForExit(5000)) 'Closing worker window stops the process.'
    Write-Output 'PASS: Worker starts and stops with a neutral executable name.'

    $wrongParentArguments = "--local-parent $PID --local-parent-start 1 --local-title $encodedTitle"
    $worker = Start-Process -FilePath $neutralPath -ArgumentList $wrongParentArguments -PassThru -WindowStyle Hidden
    Assert-True ($worker.WaitForExit(5000) -and $worker.ExitCode -eq 3) 'Worker rejects a mismatched parent identity.'
    Write-Output 'PASS: Worker rejects a reused or incorrect parent identity.'

    $parentScriptPath = Join-Path $testDirectory 'parent.ps1'
    $parentScript = @'
param([string]$WorkerPath, [string]$MarkerPath, [string]$Title)
$parentProcess = [Diagnostics.Process]::GetCurrentProcess()
$arguments = "--local-parent $PID --local-parent-start $($parentProcess.StartTime.ToUniversalTime().Ticks) --local-title $Title"
$child = Start-Process -FilePath $WorkerPath -ArgumentList $arguments -PassThru -WindowStyle Hidden
[IO.File]::WriteAllText($MarkerPath, [string]$child.Id)
Start-Sleep -Seconds 30
'@
    [IO.File]::WriteAllText($parentScriptPath, $parentScript)
    $markerPath = Join-Path $testDirectory 'child-id.txt'
    $parentArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $parentScriptPath + '"'), '-WorkerPath', ('"' + $neutralPath + '"'), '-MarkerPath', ('"' + $markerPath + '"'), '-Title', $encodedTitle)
    $parent = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $parentArguments -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while (-not (Test-Path -LiteralPath $markerPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Assert-True (Test-Path -LiteralPath $markerPath) 'Temporary parent launched the worker.'
    $orphan = Get-Process -Id ([int][IO.File]::ReadAllText($markerPath))
    $null = $orphan.WaitForInputIdle(5000)
    Start-Sleep -Milliseconds 300
    Assert-True (-not $orphan.HasExited) 'Worker is alive before its parent exits.'
    $parent.Kill()
    $null = $parent.WaitForExit(3000)
    Assert-True ($orphan.WaitForExit(5000)) 'Worker exits automatically after parent termination.'
    Write-Output 'PASS: Worker automatically exits when its launcher is terminated.'
}
finally {
    foreach ($ownedProcess in @($worker, $parent, $orphan)) {
        if ($null -ne $ownedProcess) {
            try { if (-not $ownedProcess.HasExited) { $ownedProcess.Kill(); $null = $ownedProcess.WaitForExit(3000) } } catch { }
            $ownedProcess.Dispose()
        }
    }
}

Write-Output 'All verification passed. Discord detection and badge credit were not tested.'
