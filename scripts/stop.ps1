Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (Test-Path -LiteralPath 'studio.pid') {
 $studioProcessId = [int](Get-Content -LiteralPath 'studio.pid')
 $studioProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $studioProcessId"
 if ($studioProcess -and $studioProcess.Name -eq 'node.exe' -and $studioProcess.CommandLine -like '*server/index.ts*') {
   $studioChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId = $studioProcessId"
   $studioChildren | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
   Stop-Process -Id $studioProcessId -ErrorAction SilentlyContinue
 }
 Remove-Item -LiteralPath 'studio.pid'
}
