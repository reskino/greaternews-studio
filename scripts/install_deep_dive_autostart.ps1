# Installs the GreaterNews Deep Dive Studio as an auto-restarting logon task.
# Run it from a normal PowerShell:
#     powershell -ExecutionPolicy Bypass -File C:\GreaterNews\scripts\install_deep_dive_autostart.ps1
# It will pop a UAC prompt (click Yes) to get the admin rights Task Scheduler needs.
#
# Result: the panel (http://localhost:5200) starts at every logon AND restarts within a
# minute if it ever crashes. Replaces the Startup-folder shortcut so nothing double-runs.

$ErrorActionPreference = 'Stop'
$taskName = 'GreaterNews Deep Dive Studio'

# --- self-elevate if not already admin ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'Requesting administrator privileges (click Yes on the prompt)...'
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -NoProfile -File `"$PSCommandPath`""
    return
}

# --- locate pythonw (hidden, no console) ---
$pyw = 'C:\Users\Administrator\anaconda3\pythonw.exe'
if (-not (Test-Path $pyw)) {
    $p = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($p) { $pyw = Join-Path (Split-Path $p) 'pythonw.exe' }
}
if (-not (Test-Path $pyw)) { Write-Host "ERROR: could not find pythonw.exe"; Read-Host 'Enter to close'; return }
$script = 'C:\GreaterNews\scripts\deep_dive_studio.py'
$wd = 'C:\GreaterNews'
Write-Host "Using: $pyw"

# --- remove the Startup-folder shortcut so we do not double-launch ---
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'GreaterNews Deep Dive Studio.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed Startup shortcut." }

# --- stop any running instance so the task can bind :5200 ---
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -like '*deep_dive_studio.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped running instance (PID $($_.ProcessId))." }

# --- register the auto-restarting logon task ---
$action = New-ScheduledTaskAction -Execute $pyw -Argument ('"{0}"' -f $script) -WorkingDirectory $wd
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
$trigger.Delay = 'PT15S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Description 'Local Deep Dive Studio panel (http://localhost:5200) - auto-restart' `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host 'Task registered (starts at logon, restarts on crash).'

# --- start it now and verify ---
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5
Write-Host ("Task state: {0}" -f (Get-ScheduledTask -TaskName $taskName).State)
try {
    $r = Invoke-WebRequest -UseBasicParsing http://localhost:5200/spec -TimeoutSec 6
    Write-Host ("RUNNING: HTTP {0} at http://localhost:5200" -f $r.StatusCode)
} catch {
    Write-Host ("Not responding yet (it may take a few seconds): {0}" -f $_.Exception.Message)
}
Write-Host ''
Write-Host 'Done. To undo: run  Unregister-ScheduledTask -TaskName "GreaterNews Deep Dive Studio" -Confirm:$false  in an admin shell.'
Read-Host 'Press Enter to close'
