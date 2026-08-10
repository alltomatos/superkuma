#Requires -RunAsAdministrator
<#
    Installs windows_exporter as a Windows service (Prometheus metrics on :9182), so
    SuperKuma's `prometheus` monitor type has CPU/RAM/disk data to query for this host.
    See references/prometheus-exporters.md in this skill for the metric names and PromQL.

    Idempotent: safe to re-run (uninstalls an existing service first) if you need to change
    collectors or the port.

    Usage:
        .\install-windows_exporter.ps1
        .\install-windows_exporter.ps1 -MsiPath "C:\path\to\windows_exporter-0.31.8-amd64.msi"
        .\install-windows_exporter.ps1 -Version 0.31.8 -Port 9182 -Collectors "cpu,memory,logical_disk,net,os,service,system"

    For SQL Server hosts, add the mssql collector to also expose buffer-cache-hit-ratio raw
    counters (see prometheus-exporters.md for the PromQL):
        .\install-windows_exporter.ps1 -Collectors "cpu,memory,logical_disk,net,os,service,system,mssql"
#>

param(
    [string]$MsiPath = "",
    [string]$Version = "0.31.8",
    [int]$Port = 9182,
    [string]$Collectors = "cpu,memory,logical_disk,net,os,service,system"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    AVISO: $msg" -ForegroundColor Yellow }

# 1. Stop any instance running in a foreground console (e.g. someone tested it manually first)
Write-Step "Checking for a windows_exporter.exe already running (console mode)"
$proc = Get-Process -Name "windows_exporter*" -ErrorAction SilentlyContinue
if ($proc) {
    $proc | ForEach-Object {
        Write-Warn2 "Killing PID $($_.Id) ($($_.ProcessName))"
        Stop-Process -Id $_.Id -Force
    }
    Start-Sleep -Seconds 2
} else {
    Write-Ok "No console process found"
}

# 2. If a service already exists, remove it first so re-running with different flags is clean
Write-Step "Checking for an existing windows_exporter service"
$svc = Get-Service -Name "windows_exporter" -ErrorAction SilentlyContinue
if ($svc) {
    Write-Warn2 "Existing service found (status: $($svc.Status)) -- removing before reinstall"
    Stop-Service -Name "windows_exporter" -Force -ErrorAction SilentlyContinue
    $existingMsi = (Get-WmiObject -Class Win32_Product -Filter "Name like 'windows_exporter%'" -ErrorAction SilentlyContinue)
    if ($existingMsi) {
        $existingMsi | ForEach-Object { $_.Uninstall() | Out-Null }
    } else {
        sc.exe delete windows_exporter | Out-Null
    }
    Start-Sleep -Seconds 2
} else {
    Write-Ok "No existing service"
}

# 3. Locate or download the MSI
Write-Step "Locating the MSI installer"
if ($MsiPath -and (Test-Path $MsiPath)) {
    Write-Ok "Using supplied MSI: $MsiPath"
} else {
    $downloadsGuess = Join-Path $env:USERPROFILE "Downloads\windows_exporter-$Version-amd64.msi"
    if (Test-Path $downloadsGuess) {
        $MsiPath = $downloadsGuess
        Write-Ok "Found MSI in Downloads: $MsiPath"
    } else {
        $url = "https://github.com/prometheus-community/windows_exporter/releases/download/v$Version/windows_exporter-$Version-amd64.msi"
        $MsiPath = Join-Path $env:TEMP "windows_exporter-$Version-amd64.msi"
        Write-Step "Not found locally -- downloading from $url"
        Invoke-WebRequest -Uri $url -OutFile $MsiPath -UseBasicParsing
        Write-Ok "Downloaded to $MsiPath"
    }
}

# 4. Install as a service, with the firewall exception and chosen collectors
Write-Step "Installing windows_exporter (collectors: $Collectors, port: $Port)"
$msiArgs = @(
    "/i", "`"$MsiPath`"",
    "/qn",
    "ENABLED_COLLECTORS=$Collectors",
    "LISTEN_PORT=$Port",
    "ADDLOCAL=FirewallException"
)
$proc = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "msiexec failed with exit code $($proc.ExitCode)"
}
Write-Ok "Install complete"

# 5. Make sure the service is running and set to auto-start
Write-Step "Starting the service"
Set-Service -Name "windows_exporter" -StartupType Automatic
Start-Service -Name "windows_exporter"
Start-Sleep -Seconds 3

$svc = Get-Service -Name "windows_exporter"
if ($svc.Status -ne "Running") {
    throw "Service did not reach Running (current status: $($svc.Status))"
}
Write-Ok "Service 'windows_exporter' running (StartupType: Automatic)"

# 6. Belt-and-suspenders firewall rule (ADDLOCAL=FirewallException should already cover this)
Write-Step "Checking the firewall rule on port $Port"
$fwRule = Get-NetFirewallRule -DisplayName "*windows_exporter*" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    New-NetFirewallRule -DisplayName "windows_exporter" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
    Write-Ok "Firewall rule created"
} else {
    Write-Ok "Firewall rule already exists"
}

# 7. Confirm the metrics endpoint actually responds locally
Write-Step "Testing http://localhost:$Port/metrics"
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:$Port/metrics" -UseBasicParsing -TimeoutSec 10
    if ($resp.StatusCode -eq 200) {
        Write-Ok "Endpoint responding (HTTP 200, $($resp.Content.Length) bytes)"
    }
} catch {
    Write-Warn2 "Could not validate the endpoint locally: $_"
}

Write-Host ""
Write-Host "=== windows_exporter installed as a service ===" -ForegroundColor Green
Write-Host "Service: windows_exporter (Automatic, Running)"
Write-Host "Metrics: http://$($env:COMPUTERNAME):$Port/metrics"
Write-Host "Collectors: $Collectors"
Write-Host ""
Write-Host "Next: from the SuperKuma host, confirm it can reach this port (firewall + routing)," -ForegroundColor DarkGray
Write-Host "then point Prometheus at it (see references/prometheus-exporters.md) and create a" -ForegroundColor DarkGray
Write-Host "SuperKuma 'prometheus' monitor with a PromQL threshold query." -ForegroundColor DarkGray
