# Docker deployment: Windows and Linux

Publikator runs as one Linux Docker container on both Windows and Linux. Runtime data is stored in a Docker named volume by default, so the same Compose file does not depend on Windows/Linux host filesystem permissions.

## Requirements

### Windows

- Windows 10/11 x64;
- Docker Desktop in Linux containers mode;
- Git;
- PowerShell 5.1+.

### Linux

- x86_64 Linux;
- Docker Engine;
- Docker Compose v2 (`docker compose`);
- Git.

## Recommended fresh install

Clone the repository and check out the release tag/commit you intend to run.

### Windows

```powershell
git clone https://github.com/spikeal8-maker/Publikator.git
cd Publikator
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-windows.ps1 -PublicBaseUrl "https://publisher.example.ru"
```

### Linux

```bash
git clone https://github.com/spikeal8-maker/Publikator.git
cd Publikator
bash scripts/deploy-linux.sh "https://publisher.example.ru"
```

On the first run each script creates `.env` with random `ADMIN_PASSWORD` and `APP_MASTER_KEY`, embeds the current Git SHA into the Docker image, builds the container and waits for Docker health to become `healthy`.

The generated `.env` is never overwritten by the scripts. Back it up securely. `APP_MASTER_KEY` is required to decrypt social credentials after restore and is intentionally not included in backup bundles.

## Default networking

Compose publishes the application only on loopback:

```text
127.0.0.1:8080 -> container:8080
```

This is the recommended configuration when nginx, Caddy or another reverse proxy terminates HTTPS on the same server.

Variables:

```env
PUBLIKATOR_BIND=127.0.0.1
PUBLIKATOR_PORT=8080
PUBLIC_BASE_URL=https://publisher.example.ru
```

Set `PUBLIKATOR_BIND=0.0.0.0` only deliberately when another Docker/host topology requires direct access, and protect that port with the host/network firewall.

For MAX and Instagram, `PUBLIC_BASE_URL` must be reachable from the public internet over HTTPS because those platforms fetch `/public-media/...` themselves.

## Persistent data

Default:

```env
PUBLIKATOR_DATA_SOURCE=publikator-data
```

This creates a Docker named volume and works consistently on Windows Docker Desktop and Linux Docker Engine. `docker compose down` does not delete it. `docker compose down -v` does delete it and must not be used on a production installation unless data destruction is intended.

Advanced Linux users can use a bind mount:

```env
PUBLIKATOR_DATA_SOURCE=./data
```

In that mode the host directory must be writable by container UID 1000. Named volume remains the recommended default.

## Verification

```bash
curl http://127.0.0.1:8080/api/health
```

Expected fields include:

```json
{
  "ok": true,
  "service": "publikator",
  "buildSha": "<40-char git sha>",
  "schemaVersion": 3
}
```

Also verify Docker reports `healthy`.

## Update

1. Create/download a full `.tgz` backup from Publikator.
2. Keep the existing `.env` and Docker named volume.
3. Check out the new release tag/commit.
4. Update `BUILD_SHA` in `.env` to the exact `git rev-parse HEAD` if it is not already updated by the deployment script.
5. Run the same Windows/Linux deployment script again.
6. Verify `/api/health`, Diagnostics and Release gate.

Do not replace `APP_MASTER_KEY` during an update.

## Backup and disaster recovery

The application-level canonical backup is the `.tgz` bundle produced by Publikator (SQLite + media + manifest). Docker volume persistence is not a substitute for backups.

Before moving to another machine, create a full backup and preserve the original `APP_MASTER_KEY`. Restore the bundle on the new installation through the Publikator restore flow.
