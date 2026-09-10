# RC toolchain hardening note

Этот файл фиксирует отдельный pre-live hardening шаг после `0.8.0-rc.3`.

Цель: сделать production Docker build воспроизводимым не только на уровне npm lockfile, но и на уровне Node base image.

Acceptance перед merge:

- `Toolchain CI` — PASS;
- `Dependency security CI` — PASS;
- `CI` — PASS;
- `Ops hardening CI` — PASS;
- `Content plan CI` — PASS;
- `Release gate CI` — PASS;
- `Backup path CI` — PASS.

После merge именно новый `main` commit, а не прежний RC3 SHA, должен использоваться как `APP_BUILD_SHA` для live Telegram/VK/MAX/Instagram acceptance.
