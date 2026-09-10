# Production toolchain security

Publikator выпускается как один Docker-контейнер. Release identity состоит не только из исходного Git commit, но и из зафиксированного dependency graph и Docker base.

## Зафиксированный baseline

- Node.js runtime: `22.23.2`;
- Docker base: `node:22.23.2-bookworm-slim`;
- base digest: `sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`;
- npm dependency graph: `package-lock.json`, lockfile v3;
- production install: `npm ci`;
- high/critical production vulnerability блокирует `Publikator CI / Acceptance`;
- runtime работает не от root;
- build и runtime используют один pinned Node base.

## Baked release revision

Release image собирается так:

```bash
export BUILD_SHA="$(git rev-parse HEAD)"
docker compose build --no-cache
```

`BUILD_SHA` доступен только на этапе build. Dockerfile сохраняет его как:

```text
ENV IMAGE_BUILD_SHA=<sha>
LABEL org.opencontainers.image.revision=<sha>
```

`docker-compose.yml` не передаёт `APP_BUILD_SHA` в production runtime. Поэтому обычное изменение runtime environment не может подменить release identity, зашитую в образ.

В production Release gate использует `IMAGE_BUILD_SHA`. `APP_BUILD_SHA` сохранён в коде только для non-production/test compatibility.

## Что проверяет CI

Единый `.github/workflows/publikator-ci.yml` проверяет:

```text
npm ci
npm audit --omit=dev --audit-level=high
pinned Node base digest
production Docker build
IMAGE_BUILD_SHA == tested GitHub SHA
OCI revision label == tested GitHub SHA
Node == v22.23.2
runtime UID != 0
full container backup/restore smoke
```

То есть green acceptance относится к конкретному tested revision, а не просто к исходному каталогу.

## Почему Docker digest обязателен

Плавающий tag `node:22-bookworm-slim` может через время ссылаться на другой образ. Тогда один и тот же Git commit соберётся на другом системном baseline. Pinned multi-arch digest делает базовый образ неизменяемым до отдельного upgrade PR.

## Ограничение воспроизводимости

Pinned base digest + `package-lock.json` существенно уменьшают дрейф, но не означают математически byte-for-byte reproducible image: Dockerfile выполняет `apt-get update/install`, а Debian repository со временем меняется.

Поэтому release evidence желательно хранить как:

```text
Git commit SHA
package-lock SHA-256
Docker base digest
финальный Docker image digest
```

Для текущего масштаба проекта вводить Nix/Bazel/собственный Debian snapshot repository не требуется.

## Base image CVE

Pinned digest не означает «образ без CVE». Он означает, что известен точный образ, который проверялся.

При обновлении base image:

1. выбрать новый официальный Node 22 patch image/digest;
2. отдельный PR;
3. `Publikator CI / Acceptance`;
4. native regression Sharp / better-sqlite3;
5. новый live acceptance build SHA перед стабильным release.

Нельзя автоматически менять Debian → Alpine/distroless прямо в release-hardening PR без полного native/media regression.

## Запрещено

- плавающий production Node tag без digest;
- удаление `package-lock.json`;
- `npm install` вместо `npm ci` в acceptance/production build;
- `npm audit fix --force` без анализа breaking changes;
- runtime-подмена baked release SHA;
- считать Git SHA единственным доказательством бинарного release без учёта base/lock/image identity.
