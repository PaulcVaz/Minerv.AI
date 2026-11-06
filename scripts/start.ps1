$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Install Node.js 24 LTS, then open Start-Studio.cmd again.' }
$studioNodeVersion = (& node --version).TrimStart('v').Split('.')[0]
if ([int]$studioNodeVersion -lt 24) { throw 'Node.js 24 or newer is required.' }
try { $health = Invoke-RestMethod 'http://127.0.0.1:4310/api/health' -TimeoutSec 2 } catch { $health = $null }
if ($health.ok) { Start-Process 'http://127.0.0.1:4310'; exit 0 }
if (-not (Test-Path -LiteralPath 'node_modules/tsx')) {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) { throw 'npm was not found. Install the standard Node.js 24 distribution.' }
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& node node_modules/tsx/dist/cli.mjs scripts/create-demo.ts
if ($LASTEXITCODE -ne 0) { throw 'Demo setup failed. Check FFmpeg installation.' }
& node node_modules/typescript/bin/tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Type checking failed.' }
& node node_modules/vite/bin/vite.js build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
$studioLog = Join-Path (Get-Location) 'studio.log'
$studioErrorLog = Join-Path (Get-Location) 'studio-error.log'
$studioProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @('node_modules/tsx/dist/cli.mjs','server/index.ts') -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput $studioLog -RedirectStandardError $studioErrorLog -PassThru
for ($attempt=0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 500
  try { $health = Invoke-RestMethod 'http://127.0.0.1:4310/api/health' -TimeoutSec 1; if ($health.ok) { break } } catch {}
}
if (-not $health.ok) { throw 'The server did not start. See studio-error.log.' }
$studioProcess.Id | Set-Content -LiteralPath 'studio.pid'
Start-Process 'http://127.0.0.1:4310'
Write-Host 'AI Video Studio is running at http://127.0.0.1:4310. Close it with Stop-Studio.cmd.'
