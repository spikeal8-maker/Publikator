# Docker deployment: Windows and Linux

Publikator runs as one Linux Docker container on both Windows and Linux. Runtime data is stored in a Docker named volume by default, so the same Compose file does not depend on Windows/Linux host filesystem permissions.

## Requirements

### Windows

- Windows 10/11 x64;
- Docker Desktop;
- Git;
- PowerShell 5.1+.

Docker Desktop must ultimately run **Linux containers**. The launcher checks this itself.

The Windows launcher searches for Docker in two places:

1. `docker.exe` available through `PATH`;
2. the standard Docker Desktop path under `C:\Program Files\Docker\Docker\resources\bin\docker.exe`.

If Docker Desktop is installed but its Engine is stopped, the launcher starts `Docker Desktop.exe` from the standard installation folder and waits up to about two minutes for the Engine. If Docker is missing, installed in a non-standard location that is not in `PATH`, or cannot start, the script stops with a clear error.

The launcher does **not install Docker Desktop itself**. Docker is a system prerequisite.

### Linux

- x86_64 Linux;
- Docker Engine;
- Docker Compose v2 (`docker compose`);
- Git.

The current user must be allowed to access the Docker daemon. The Linux launcher checks both the CLI and the daemon. If Docker is installed but stopped, or the current user has no permission to use it, deployment stops before any application data is changed.

## Recommended fresh install

Clone the repository and check out the release tag you intend to run.

### Windows

Open PowerShell and run:

```powershell
git clone https://github.com/spikeal8-maker/Publikator.git
cd Publikator
git checkout v1.0.0-rc.4
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-windows.ps1
```

For a public installation you may pass the final HTTPS base URL immediately:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-windows.ps1 -PublicBaseUrl "https://publisher.example.ru"
```

### Linux

```bash
git clone https://github.com/spikeal8-maker/Publikator.git
cd Publikator
git checkout v1.0.0-rc.4
bash scripts/deploy-linux.sh
```

For a public installation:

```bash
bash scripts/deploy-linux.sh "https://publisher.example.ru"
```

## What the launchers do

The launchers are project deployment orchestrators, not Docker installers. They validate the host first and then create the complete Publikator runtime.

On a clean install they:

1. verify Docker CLI and Docker Compose v2;
2. verify the Docker Engine is actually available;
3. verify Linux-containers mode;
4. verify Git and read the exact 40-character commit SHA;
5. generate random `ADMIN_PASSWORD` and `APP_MASTER_KEY`;
6. create `.env`;
7. use a Docker named volume for persistent data;
8. build the image with that exact Git SHA;
9. start the container;
10. wait until Docker reports `healthy`;
11. print the local URL and build SHA.

On Windows, a clean install also checks whether TCP port `8080` is already in use before generating `.env`. If it is occupied, the script stops and tells you to choose another `PUBLIKATOR_PORT`.

On later runs the scripts preserve existing secrets and deployment settings and update only `BUILD_SHA` to the current Git commit before rebuilding the image. Back `.env` up securely. `APP_MASTER_KEY` is required to decrypt social credentials after restore and is intentionally not included in backup bundles.

## Default networking

Compose publishes the application only on loopback:

```text
127.0.0.1:8080 -> container:8080
```

This means another computer cannot reach Publikator directly by default. It is the recommended configuration when nginx, Caddy or another reverse proxy terminates HTTPS on the same server.

Variables:

```env
PUBLIKATOR_BIND=127.0.0.1
PUBLIKATOR_PORT=8080
PUBLIC_BASE_URL=https://publisher.example.ru
```

To use another host port, for example `18088`:

```env
PUBLIKATOR_PORT=18088
```

Then the local UI is:

```text
http://127.0.0.1:18088
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

Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/api/health
```

Linux:

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

Also verify Docker reports the container as `healthy`.

## Update

1. Create/download a full `.tgz` backup from Publikator.
2. Keep the existing `.env` and Docker named volume.
3. Check out the new release tag/commit.
4. Run the same launcher again.
5. The launcher refreshes only `BUILD_SHA` to the exact `git rev-parse HEAD` while preserving secrets/settings.
6. Verify `/api/health`, Diagnostics and Release gate.

Do not replace `APP_MASTER_KEY` during an update.

## Backup and disaster recovery

The application-level canonical backup is the `.tgz` bundle produced by Publikator (SQLite + media + manifest). Docker volume persistence is not a substitute for backups.

Before moving to another machine, create a full backup and preserve the original `APP_MASTER_KEY`. Restore the bundle on the new installation through the Publikator restore flow.
