$ErrorActionPreference = 'Stop'
# This optional build-time script contacts only Discord's public CDN.
$sourceUrl = 'https://cdn.discordapp.com/detectables/games.json'
$response = Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl
$sourceGames = $response.Content | ConvertFrom-Json
$catalogGames = New-Object 'System.Collections.Generic.List[object]'
foreach ($game in $sourceGames) {
    if ([string]$game.id -notmatch '^\d+$' -or -not $game.name) { continue }
    $entries = New-Object 'System.Collections.Generic.List[object]'
    foreach ($entry in $game.executables) {
        if ($entry.os -ne 'win32' -or $entry.is_launcher -eq $true) { continue }
        $relativePath = [string]$entry.name
        if (-not $relativePath.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::IsPathRooted($relativePath)) { continue }
        $valid = $true
        foreach ($part in $relativePath.Replace('\', '/').Split('/')) {
            $deviceName = $part.Split('.')[0]
            if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
                $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
                $deviceName -match '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$') { $valid = $false; break }
        }
        if ($valid) { $entries.Add([ordered]@{ path = $relativePath; arguments = [string]$entry.arguments }) }
    }
    if ($entries.Count -gt 0) {
        $catalogGames.Add([ordered]@{ id = [string]$game.id; name = [string]$game.name; executables = @($entries.ToArray()) })
    }
}
if ($catalogGames.Count -lt 100) { throw 'The downloaded catalog is unexpectedly small; the existing snapshot was not changed.' }
$catalog = [ordered]@{
    source = $sourceUrl
    downloadedAtUtc = [DateTime]::UtcNow.ToString('o')
    games = @($catalogGames.ToArray() | Sort-Object { $_.name })
}
$catalogPath = Join-Path $PSScriptRoot 'data\games.json'
[IO.File]::WriteAllText($catalogPath, ($catalog | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
Write-Output "Saved $($catalogGames.Count) games from $sourceUrl. Run build.ps1 to embed the new catalog."
