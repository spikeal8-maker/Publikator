param(
  [string]$PublicBaseUrl = 'http://127.0.0.1:8080'
)

$ErrorActionPreference = 'Stop'

function Get-DockerCli {
  $command = Get-Command docker -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidate = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
  if (Test-Path $candidate) {
    $env:Path = "$(Split-Path $candidate);$env:Path"
    return $candidate
  }

  throw 'Docker Desktop is required. docker.exe was not found in PATH or the standard Docker Desktop installation folder.'
}

function Get-DockerEngineOs {
  try {
    $output = & docker info --format '{{.OSType}}' 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return (($output | Select-Object -First 1) -as [string]).Trim()
  } catch {
    return ''
  }
}

$dockerCli = Get-DockerCli
Write-Host "Docker CLI found: $dockerCli"

& docker compose version | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 (docker compose) is required.' }

$engineOs = Get-DockerEngineOs
if (-not $engineOs) {
  $desktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktopExe) {
    Write-Host 'Docker Desktop is installed but the engine is not ready. Starting Docker Desktop...'
    Start-Process -FilePath $desktopExe | Out-Null
    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Seconds 1
      $engineOs = Get-DockerEngineOs
      if ($engineOs) { break }
    }
  }
}

if (-not $engineOs) {
  throw 'Docker CLI is installed, but Docker Engine is not available. Start Docker Desktop and wait until it reports that the engine is running.'
}
if ($engineOs -ne 'linux') {
  throw "Docker is running in '$engineOs' containers mode. Publikator requires Docker Desktop Linux containers mode."
}
Write-Host 'Docker Engine is ready in Linux containers mode.'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required to embed the exact release commit SHA.' }
$buildSha = (git rev-parse HEAD).Trim()
if ($buildSha -notmatch '^[a-f0-9]{40}$') { throw 'Current folder is not a valid Git checkout with a 40-character commit SHA.' }

if (-not (Test-Path '.env')) {
  $listener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    throw 'TCP port 8080 is already in use. Create .env from .env.example and choose another PUBLIKATOR_PORT before the first launch.'
  }

  $admin = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
  $master = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
  @(
    "PUBLIC_BASE_URL=$PublicBaseUrl",
    'PUBLIKATOR_BIND=127.0.0.1',
    'PUBLIKATOR_PORT=8080',
    'PUBLIKATOR_DATA_SOURCE=publikator-data',
    'TRUST_PROXY=',
    "ADMIN_PASSWORD=$admin",
    "APP_MASTER_KEY=$master",
    'SESSION_TTL_HOURS=24',
    'SCHEDULER_INTERVAL_MS=15000',
    'QUEUE_SLOT_GRACE_MINUTES=60',
    'EVENT_RETENTION_DAYS=180',
    'BACKUP_RETENTION_COUNT=30',
    "BUILD_SHA=$buildSha",
    'RELEASE_TARGET_VERSION=1.0.0'
  ) | Set-Content -Encoding ascii '.env'
  Write-Host 'Created .env with random ADMIN_PASSWORD and APP_MASTER_KEY.'
} else {
  Write-Host 'Using existing .env; secrets and deployment settings are preserved.'
  $lines = @(Get-Content '.env')
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^BUILD_SHA=') {
      $lines[$i] = "BUILD_SHA=$buildSha"
      $found = $true
    }
  }
  if (-not $found) { $lines += "BUILD_SHA=$buildSha" }
  $lines | Set-Content -Encoding ascii '.env'
  Write-Host "Updated BUILD_SHA=$buildSha"
}

docker compose --env-file .env config | Out-Null
docker compose --env-file .env up -d --build

$status = ''
for ($i = 0; $i -lt 60; $i++) {
  try { $status = (docker inspect publikator --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}').Trim() } catch { $status = '' }
  if ($status -eq 'healthy') { break }
  Start-Sleep -Seconds 1
}

if ($status -ne 'healthy') {
  docker compose --env-file .env logs --tail=100 publikator
  throw "Publikator did not become healthy: $status"
}

$port = '8080'
$portLine = Get-Content '.env' | Where-Object { $_ -match '^PUBLIKATOR_PORT=' } | Select-Object -First 1
if ($portLine) { $port = ($portLine -split '=', 2)[1].Trim() }

Write-Host 'Publikator is healthy.'
Write-Host "Local UI: http://127.0.0.1:$port"
Write-Host "Build SHA: $buildSha"
Write-Host 'Credentials are stored only in .env. Keep APP_MASTER_KEY safe.'
