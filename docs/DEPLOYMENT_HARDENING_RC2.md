# Deployment hardening — 1.0.0-rc.2

This RC changes deployment packaging only; runtime architecture remains one Fastify/SQLite Docker container.

## Stage 1 — portable Compose

- default data storage is Docker named volume `publikator-data`;
- default published address is `127.0.0.1:8080`;
- `PUBLIKATOR_BIND`, `PUBLIKATOR_PORT`, `PUBLIKATOR_DATA_SOURCE` are explicit overrides;
- host bind mount remains opt-in for operators who manage Linux UID/permissions themselves.

## Stage 2 — configuration fail-fast

- public `.env.example` placeholders are rejected at startup;
- `ADMIN_PASSWORD` minimum length is 12;
- `APP_MASTER_KEY` minimum length is 32;
- existing `.env` is never silently overwritten by deployment launchers.

## Stage 3 — Windows/Linux launch and acceptance

- `scripts/deploy-windows.ps1` for Docker Desktop;
- `scripts/deploy-linux.sh` for Docker Engine + Compose v2;
- both generate random secrets on the first run and wait for Docker health;
- Linux CI runs a real `docker compose up` fresh install, verifies named-volume mount, performs `down → up` persistence check, and confirms placeholder secrets fail closed;
- Windows Docker Desktop acceptance was also executed on D2-R2-X: named volume created, health passed, and a persisted file survived `docker compose down → up`.

## Production rule

For MAX/Instagram, the deployment is not complete until `PUBLIC_BASE_URL` is publicly reachable over HTTPS. Keep the application bound to loopback when nginx/Caddy runs on the same host; expose `0.0.0.0` only deliberately for another controlled ingress topology.
