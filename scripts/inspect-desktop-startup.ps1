param(
  [ValidateSet('current', 'before', 'after')][string]$Phase = 'current',
  [ValidateRange(1, 65535)][int]$BridgePort = 8765,
  [ValidateRange(1, 65535)][int]$AppServerPort = 8766
)

function Get-OverrideKind([string]$Scope) {
  $value = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $Scope)
  if (!$value) { return 'absent' }
  if ($value -ceq "ws://127.0.0.1:$AppServerPort") { return 'legacy-bridge' }
  return 'other'
}

$packages = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop)
$processes = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='codex.exe' OR Name LIKE '%Cockpit%'" -ErrorAction Stop |
  Select-Object Name, ProcessId, ParentProcessId)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
  Where-Object LocalPort -In $BridgePort, $AppServerPort |
  Select-Object LocalAddress, LocalPort, OwningProcess)
$task = Get-ScheduledTask -TaskName 'CodexBridge-Shared-Startup' -TaskPath '\' -ErrorAction SilentlyContinue
$taskInfo = if ($task) { Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop }
$startup = foreach ($package in $packages) {
  $startupKey = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\' + $package.PackageFamilyName + '\App'
  Get-ItemPropertyValue -LiteralPath $startupKey -Name State -ErrorAction SilentlyContinue
}

$logPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "CodexBridge\startup-$BridgePort-$AppServerPort\status.log"
$events = if (Test-Path -LiteralPath $logPath -PathType Leaf) {
  foreach ($line in (Get-Content -LiteralPath $logPath -Tail 40)) {
    if ($line -notmatch '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*)$') { continue }
    $time = $Matches[1]
    $event = $Matches[2]
    if ($event -match '^(App Server ready|Bridge connected)\. PID (\d+)\.') {
      [pscustomobject]@{ Time = $time; Event = $Matches[1]; Pid = [int]$Matches[2] }
    } elseif ($event -eq 'Desktop connected to the same App Server.') {
      [pscustomobject]@{ Time = $time; Event = 'Desktop connected' }
    } elseif ($event.StartsWith('ERROR ')) {
      [pscustomobject]@{ Time = $time; Event = 'Legacy startup error' }
    }
  }
}

[ordered]@{
  Time = (Get-Date).ToString('o')
  Phase = $Phase
  DesktopVersions = @($packages | ForEach-Object { [string]$_.Version })
  Processes = $processes
  Listeners = $listeners
  UserOverride = Get-OverrideKind 'User'
  MachineOverride = Get-OverrideKind 'Machine'
  DesktopStartupState = @($startup)
  LegacyTask = if ($task) { @{ State = [string]$task.State; Enabled = $task.Settings.Enabled; LastResult = $taskInfo.LastTaskResult } }
  LegacyEvents = @($events | Where-Object { $_ })
  FollowerPipePresent = [IO.Directory]::GetFiles('\\.\pipe\') -contains '\\.\pipe\codex-ipc'
} | ConvertTo-Json -Depth 4
