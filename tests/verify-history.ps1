$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$assembly = [Reflection.Assembly]::LoadFile((Join-Path $projectRoot 'dist\BadgeBooster.exe'))
$type = $assembly.GetType('Launcher')
$flags = [Reflection.BindingFlags]'Instance,NonPublic'
$temp = Join-Path $PSScriptRoot ('output\history-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$statsPath = Join-Path $temp 'stats.txt'
# Avoid constructing a window or touching the real profile. Exercise only stats migration.
$hostObject = [Runtime.Serialization.FormatterServices]::GetUninitializedObject($type)
$played = New-Object 'System.Collections.Generic.HashSet[string]'
1..312 | ForEach-Object { $null = $played.Add([string]$_) }
foreach ($item in @{
    statsPath = $statsPath; dataRoot = $temp; played = $played
    minMinutes = 10; maxMinutes = 15; legacyGames = -1; trackingSince = [DateTime]::UtcNow
}.GetEnumerator()) { $type.GetField($item.Key, $flags).SetValue($hostObject, $item.Value) }
$load = $type.GetMethod('LoadStats', $flags)
$null = $load.Invoke($hostObject, @())
if ($type.GetField('legacyGames', $flags).GetValue($hostObject) -ne 312) { throw 'Earlier game count was not migrated.' }
if ($type.GetField('legacySeconds', $flags).GetValue($hostObject) -ne 234000) { throw 'Expected 65 hours estimated from 312 games at 12.5 minutes.' }
$type.GetField('maxMinutes', $flags).SetValue($hostObject, 60)
$null = $load.Invoke($hostObject, @())
if ($type.GetField('legacySeconds', $flags).GetValue($hostObject) -ne 234000) { throw 'Estimate changed after migration.' }
Write-Output 'PASS: 312 earlier records migrate to 65 estimated hours once, without changing the real profile.'
