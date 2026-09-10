# Production toolchain security

Publikator выпускается как один Docker-контейнер. Для live acceptance и стабильного V1 недостаточно только Git commit SHA: build должен быть воспроизводимым и использовать зафиксированные зависимости и базовый образ.

## Что зафиксировано

- Node.js runtime: `22.23.2`;
- Docker base: `node:22.23.2-bookworm-slim`;
- multi-arch image digest: `sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`;
- npm dependency graph: `package-lock.json`, lockfile v3;
- production install: только `npm ci`;
- production npm audit: high/critical vulnerabilities блокируют Dependency security CI;
- отдельный Toolchain CI использует Node `22.23.2` и pinned commit SHA для `actions/checkout` и `actions/setup-node`, собирает production image и проверяет фактическую Node-версию и non-root UID внутри контейнера.

## Почему digest обязателен

Плавающий tag вида `node:22-bookworm-slim` может указывать на другой image в будущем. Тогда один и тот же Git SHA мог бы собрать разные ОС/Node layers. Digest делает выбранный base image immutable.

Обновление base image выполняется только отдельным pull request: новый digest, security review, полный automated acceptance и затем новый live acceptance commit SHA.

## Важное ограничение

Зафиксированный digest не означает, что Debian/Node base image не содержит известных CVE. Это означает только, что build воспроизводим и его security-состояние можно однозначно идентифицировать.

Перед стабильным V1 и при каждом дальнейшем обновлении base image нужно отдельно проверять актуальный vulnerability report образа. Нельзя автоматически заменять runtime на Alpine/distroless без полного media/native-module regression: `sharp` и `better-sqlite3` содержат native-компоненты.

## Запрещено

- возвращать Dockerfile к плавающему `node:22-bookworm-slim` без digest;
- удалять `package-lock.json`;
- заменять `npm ci` на `npm install` в production build;
- применять `npm audit fix --force` без анализа breaking changes;
- считать один только `APP_BUILD_SHA` достаточным, если Docker base или npm graph не зафиксированы.
