param(
  [string]$LanAddress,
  [Parameter(Mandatory)][string]$Credentials,
  [ValidateRange(1, 65535)][int]$BridgePort = 8765,
  [ValidateRange(1, 65535)][int]$AppServerPort = 8766,
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
  [switch]$SkipDesktop
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$sharedUrl = "ws://127.0.0.1:$AppServerPort"
$bridgeAddress = if ($LanAddress) { $LanAddress } else { '127.0.0.1' }
$bridgeUrl = "http://$($bridgeAddress):$BridgePort"
$dataRoot = [Environment]::GetFolderPath('LocalApplicationData')
$logFolder = Join-Path $dataRoot "CodexBridge\startup-$BridgePort-$AppServerPort"
$null = New-Item -Path $logFolder -ItemType Directory -Force
$started = @()

function Write-Status([string]$line) {
  $message = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $line"
  Add-Content -LiteralPath (Join-Path $logFolder 'status.log') -Value $message -Encoding utf8
  Write-Host $message
}

function Wait-Until([scriptblock]$condition, [int]$seconds, [string]$failure) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw $failure
}

function Test-Http([string]$url) {
  try {
    return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-Background([string]$executable, [string[]]$arguments, [string]$label) {
  $options = @{
    FilePath = $executable
    ArgumentList = $arguments
    WorkingDirectory = $workspace
    WindowStyle = 'Hidden'
    PassThru = $true
    RedirectStandardOutput = Join-Path $logFolder "$label.out"
    RedirectStandardError = Join-Path $logFolder "$label.err"
  }
  Start-Process @options
}

function Get-Listener([int]$port, [string]$address) {
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if (!$listeners) { return }
  if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne $address) {
    throw "Port $port is already listening on an unexpected address."
  }
  return $listeners[0]
}

function Test-SharedClient([int[]]$ownerIds) {
  return [bool](Get-NetTCPConnection -State Established -RemoteAddress '127.0.0.1' -RemotePort $AppServerPort -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -in $ownerIds })
}

try {
  if ($BridgePort -eq $AppServerPort) { throw 'The Bridge and App Server ports must differ.' }
  if (!(Test-Path -LiteralPath $Credentials -PathType Leaf)) { throw 'The existing Bridge credentials file could not be opened.' }
  $credentialPath = (Resolve-Path -LiteralPath $Credentials).ProviderPath
  $env:CODEX_HOME = $CodexHome
  $env:CODEX_APP_SERVER_WS_URL = $sharedUrl
  $package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
  if (!$package) { throw 'The Windows Codex desktop package is not installed.' }
  $desktop = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
  $appServer = Join-Path $package.InstallLocation 'app\resources\codex.exe'
  $node = (Get-Command node.exe -CommandType Application).Source

  $listener = Get-Listener $AppServerPort '127.0.0.1'
  if ($listener) {
    $owner = Get-Process -Id $listener.OwningProcess
    if ($owner.Path -ine $appServer) { throw "Port $AppServerPort is owned by a different App Server." }
    $sharedId = $owner.Id
  } else {
    $serverProcess = Start-Background $appServer @('app-server', '--listen', $sharedUrl) 'app-server'
    $started += $serverProcess
    $sharedId = $serverProcess.Id
  }
  Wait-Until {
    $listener = Get-Listener $AppServerPort '127.0.0.1'
    $listener.OwningProcess -eq $sharedId -and (Test-Http "http://127.0.0.1:$AppServerPort/readyz")
  } 30 'The shared App Server did not become ready.'
  Write-Status "App Server ready. PID $sharedId."

  if (!$SkipDesktop) {
    $desktopProcesses = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $desktop })
    if (!$desktopProcesses) { Start-Process -FilePath $desktop }
  }

  if ($LanAddress) {
    Wait-Until {
      [bool](Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress -AddressState Preferred -ErrorAction SilentlyContinue)
    } 90 "LAN address $LanAddress is unavailable."
  }
  $listener = Get-Listener $BridgePort $bridgeAddress
  if ($listener) {
    $webId = $listener.OwningProcess
  } else {
    $arguments = @('src/server.mjs', '--port', "$BridgePort", '--cwd', ('"{0}"' -f $workspace),
      '--credentials', ('"{0}"' -f $credentialPath))
    if ($LanAddress) { $arguments += @('--lan', $LanAddress) }
    $webProcess = Start-Background $node $arguments 'bridge'
    $started += $webProcess
    $webId = $webProcess.Id
  }
  Wait-Until {
    $listener = Get-Listener $BridgePort $bridgeAddress
    $listener.OwningProcess -eq $webId -and (Test-SharedClient @($webId)) -and (Test-Http "$bridgeUrl/api/session")
  } 30 'The Bridge did not connect to the shared App Server.'
  Write-Status "Bridge connected. PID $webId. $bridgeUrl/"

  if (!$SkipDesktop) {
    Wait-Until {
      $desktopIds = @(Get-Process ChatGPT -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -ieq $desktop } | ForEach-Object Id)
      $desktopIds -and (Test-SharedClient $desktopIds)
    } 45 'The Windows desktop did not connect to the shared App Server.'
    Write-Status 'Desktop connected to the same App Server.'
  }
} catch {
  Write-Status "ERROR $($_.Exception.Message)"
  throw
}

# Keep the task alive for the services it started. Reusing running services does not take ownership.
if ($started) { Wait-Process -InputObject $started -ErrorAction SilentlyContinue }
