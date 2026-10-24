# Contributing

For larger changes, open an issue first to discuss scope.

Use Windows x64, Windows PowerShell, .NET Framework 4.8, and WebView2. Run `build.ps1` and `tests/verify.ps1`. The launcher uses the C# 5 compiler; the UI is plain HTML, CSS, and JavaScript.

Test UI flows in the browser mock. Never start a game-named placeholder during automated tests: Discord may detect it on a real account. Use neutral names for lifecycle checks. Do not commit generated executables, SDK packages, local profiles, or personal activity records.

Explain the problem, behavior changes, and verification in pull requests. Include screenshots for visible UI changes. Keep black surfaces and restrained amber accents. Preserve user data and clearly label estimates. Do not add credential collection, forged Discord requests, telemetry, or badge guarantees.

Bug reports should include app and Windows versions, reproduction steps, and expected versus actual behavior. Redact personal information. Use SECURITY.md for vulnerabilities.
