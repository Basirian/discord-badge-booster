param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework 4 C# compiler was not found.' }

# The window is drawn by Microsoft Edge WebView2. Its SDK is downloaded once from nuget.org,
# pinned to an exact version and SHA-256, and kept in packages\ for later builds.
$sdkVersion = '1.0.2903.40'
$sdkHash = 'EF128016DD1E51C59178C827ED5B8AA3322C57AFA8675D930F8109505542AD74'
$sdkRoot = Join-Path $projectRoot "packages\Microsoft.Web.WebView2.$sdkVersion"
$sdkLib = Join-Path $sdkRoot 'lib\net462'
$sdkLoader = Join-Path $sdkRoot 'runtimes\win-x64\native\WebView2Loader.dll'
if (-not (Test-Path -LiteralPath (Join-Path $sdkLib 'Microsoft.Web.WebView2.Core.dll'))) {
    $archive = Join-Path $projectRoot "packages\microsoft.web.webview2.$sdkVersion.zip"
    New-Item -ItemType Directory -Path (Split-Path $archive) -Force | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -OutFile $archive -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $sdkHash) {
        Remove-Item -LiteralPath $archive
        throw 'The downloaded WebView2 SDK does not match the pinned SHA-256. Nothing was extracted.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $sdkRoot -Force
    Remove-Item -LiteralPath $archive
}

$outputDirectory = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $projectRoot 'dist' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$placeholder = Join-Path $outputDirectory 'Placeholder.exe'
$launcher = Join-Path $outputDirectory 'BadgeBooster.exe'
$icon = Join-Path $projectRoot 'ui\app.ico'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$placeholder" (Join-Path $projectRoot 'src\Placeholder.cs')
if ($LASTEXITCODE -ne 0) { throw 'Placeholder compilation failed.' }

$core = Join-Path $sdkLib 'Microsoft.Web.WebView2.Core.dll'
$winforms = Join-Path $sdkLib 'Microsoft.Web.WebView2.WinForms.dll'
$resources = @(
    "/resource:$placeholder,Placeholder.exe",
    "/resource:$(Join-Path $projectRoot 'data\games.json'),games.json",
    "/resource:$core,Microsoft.Web.WebView2.Core.dll",
    "/resource:$winforms,Microsoft.Web.WebView2.WinForms.dll",
    "/resource:$sdkLoader,WebView2Loader.dll"
)
foreach ($page in 'index.html', 'app.css', 'app.js', 'logo.png', 'badge-variety.svg', 'badge-time.svg') { $resources += "/resource:$(Join-Path $projectRoot "ui\$page"),ui/$page" }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/win32icon:$icon" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Core.dll "/reference:$core" "/reference:$winforms" $resources "/out:$launcher" (Join-Path $projectRoot 'src\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Get-FileHash -LiteralPath $launcher,$placeholder -Algorithm SHA256 | Format-Table Hash,Path -AutoSize
Write-Output "Built $launcher (the WebView2 SDK, catalog, interface and placeholder are embedded)."
