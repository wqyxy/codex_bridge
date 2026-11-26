param(
  [string]$LanAddress,
  [string]$Credentials,
  [int]$BridgePort = 8765,
  [int]$AppServerPort = 8766,
  [string]$CodexHome,
  [switch]$SkipDesktop
)

# Accept the installed task's arguments so older deployments can update before migrating.
Write-Warning 'Shared desktop startup has been retired. Follow the Issue #2 migration guide in specs/002-desktop-startup-recovery/quickstart.md.'
