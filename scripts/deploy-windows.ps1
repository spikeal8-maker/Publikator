param(
  [string]$PublicBaseUrl = 'http://127.0.0.1:8080'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop / docker.exe is required' }
docker compose version | Out-Null

$buildSha = ''
try { $buildSha = (git rev-parse HEAD).Trim() } catch { }

if (-not (Test-Path '.env')) {
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
  if ($buildSha -match '^[a-f0-9]{40}$') {
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

Write-Host 'Publikator is healthy.'
Write-Host 'Local UI: http://127.0.0.1:8080'
Write-Host 'Credentials are stored only in .env. Keep APP_MASTER_KEY safe.'
