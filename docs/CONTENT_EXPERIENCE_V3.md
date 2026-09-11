# Content Experience v3

## Цель

Сделать Publikator визуальным контентным центром, в котором оператор не просто видит строки постов, а заранее понимает **что именно будет опубликовано, где, когда и как это будет выглядеть**.

Content Pipeline v2 отвечает за то, **как контент попадает** в Publikator. Content Experience v3 отвечает за то, **как этот контент представлен, просматривается, планируется и утверждается**.

Главный экран оператора после входа должен быть не технический scheduler, а визуальный редакционный календарь.

## 1. Типы контента

Текущая модель `post + images` недостаточна. Нужно разделить тип публикации и тип media.

### Publication kind

```text
FEED        обычная публикация в ленте
SHORT       короткое вертикальное видео / Reel / Shorts-like формат
STORY       история
```

### Media composition

```text
TEXT_ONLY       только там, где площадка это допускает
IMAGE           одно изображение
CAROUSEL        несколько изображений/видео
VIDEO           обычное видео
VERTICAL_VIDEO  9:16 short/story video
STORY_SEQUENCE  последовательность story slides
```

Одна каноническая публикация может иметь platform-specific rendition. Например, одна тема может уйти в Telegram как `FEED + IMAGE`, а в Instagram как `STORY + VERTICAL_VIDEO`.

Тип контента не должен жёстко означать конкретную соцсеть. Возможность публикации определяется capability конкретного platform adapter.

## 2. Stories

Stories являются полноценными объектами контента, а не флагом у обычного поста.

Поддержать:

- image story;
- video story;
- story sequence из нескольких кадров;
- порядок кадров;
- подпись/текст, если площадка позволяет;
- длительность видео;
- дата/время публикации;
- platform targets;
- status и history каждого target.

В библиотеке и календаре количество story objects не ограничивается искусственным глобальным лимитом Publikator.

Ограничения конкретной платформы на одну story sequence, media duration, размер, aspect ratio, частоту или API capability должны находиться в adapter capability matrix и проверяться preflight. Нельзя вводить один произвольный общий лимит для всех соцсетей.

## 3. Видео и Shorts/Reels

Publikator должен иметь полноценный video asset pipeline.

Минимум хранить:

```text
mime_type
size_bytes
width
height
duration_ms
fps (если доступно)
codec/container metadata
sha256
poster/thumbnail
```

Для видео UI должен автоматически формировать poster frame/thumbnail.

Нужен отдельный `VERTICAL_VIDEO` UX с приоритетом 9:16 и phone preview.

Importer, Integration API, ZIP bundle, Google Drive/Яндекс Диск должны принимать видео тем же принципом, что изображения.

## 4. Media Viewer / Player

Любой media asset должен открываться непосредственно в Publikator.

### Изображение

- полноэкранный viewer;
- zoom;
- fit/actual size;
- dimensions/file size;
- переключение между media одного поста.

### Video

- HTML5 player;
- play/pause;
- seek;
- mute/volume;
- duration/current time;
- fullscreen;
- poster;
- vertical phone-frame mode для SHORT/STORY.

### Carousel

- переключение стрелками/свайпом;
- номер кадра `2/7`;
- mixed media, если конкретная platform capability это разрешает.

### Story sequence

Preview как реальная последовательность историй:

```text
[────][────][────]
       progress

┌──────────────────┐
│                  │
│      media       │
│      9:16        │
│                  │
│ text / overlay   │
└──────────────────┘

← previous    next →
```

Изображения автоматически перелистываются по preview-duration, видео проигрывается по собственной длительности. Должен быть ручной переход между кадрами.

## 5. Platform-aware preview

Preview становится обязательной частью review.

Для каждого target показывать отдельную карточку:

```text
Telegram | VK | MAX | Instagram
```

Preview учитывает:

- publication kind;
- media aspect ratio;
- carousel order;
- platform override text;
- приблизительное расположение caption;
- safe zones vertical media;
- количество media;
- video duration;
- platform warnings/errors.

Preview не обещает pixel-perfect копию мобильного клиента соцсети: их интерфейсы меняются. Он должен быть **platform-aware и layout-accurate по нашим контролируемым параметрам**.

Перед READY оператор должен видеть тот же resolved content, который пойдёт в publisher adapter.

## 6. Главный экран — визуальный календарь

Технический раздел `Расписание` (QUEUE slots) оставить отдельно для настройки scheduler.

Добавить новый основной раздел `Календарь`.

Режимы:

```text
Месяц
Неделя
День
Список / Agenda
```

### Month

Каждая дата показывает компактные визуальные карточки:

```text
15 сентября
┌──────────┐ 10:00 ASA Lab
│thumbnail │ TG · VK
└──────────┘ READY

┌─────9:16─┐ 17:30 IZO
│   video  │ IG Story
└──────────┘ DRAFT
```

Не только цветная точка: thumbnail/poster обязателен там, где есть media.

### Week

Вертикальная временная сетка. Публикации стоят на реальном времени. Карточки можно открывать кликом.

### Day

Подробная последовательность публикаций дня с preview и конфликтами времени.

### Agenda

Список будущего контента:

```text
Сегодня
10:00  [img] ASA Lab — Telegram/VK        READY
15:00  [9:16] IZO Story — Instagram       DRAFT
18:00  [video] ASA Lab — MAX/Telegram     READY

Завтра
...
```

## 7. Открытие публикации из календаря

Клик на любую calendar card открывает Content Inspector без перехода в другой раздел.

Inspector:

- title/internal note;
- publication kind;
- source (manual / AI / Sheets / API / bundle);
- дата/время/timezone;
- media viewer/player;
- platform tabs;
- platform-specific text;
- preflight warnings;
- target state;
- actions `Edit / Approve / READY / Publish now / Duplicate / Delete` по допустимому status.

Для published target показывать external URL, external ID и published time.

## 8. Content Library

Кроме календаря нужен режим библиотеки для больших объёмов.

Views:

```text
All
Inbox
Draft
Ready
Scheduled
Published
Problems
Stories
Shorts / Video
```

Отображение:

- grid cards для визуального просмотра;
- table/list для массовых операций.

Grid card:

```text
[ thumbnail/poster ]
ASA Lab
Новый модуль электроники
15.09 · 10:00
TG VK IG
READY
source: AI
```

Поддержать сотни/тысячи записей через pagination/virtualization, а не отрисовывать всё DOM-списком сразу.

## 9. Количество контента и лимиты

Publikator не должен иметь маленький искусственный лимит на количество сохранённых публикаций, stories или media.

Фактические ограничения определяются:

- диском;
- разумными server upload limits;
- batch import limits;
- platform API limits;
- retention/архивацией.

Для UI обязательны pagination/filter/search.

Для массовых операций установить технические batch limits с понятным продолжением/страницами, а не общий лимит на библиотеку.

## 10. Calendar conflicts / density

Календарь должен помогать редакционно, а не только хранить даты.

Показывать warnings:

- несколько публикаций одного проекта слишком близко;
- несколько READY на один и тот же момент;
- AT в прошлом;
- media/platform incompatibility;
- story/short без vertical-safe rendition;
- target отключён;
- missing media;
- PUBLIC_BASE_URL нужен, но недоступен для соответствующей platform capability.

Warnings не должны самовольно менять расписание.

## 11. Visual language / accessibility

Текущую стилистику Publikator сохранить, но повысить контраст и информационную иерархию.

Обязательные правила:

- основной текст на светлом фоне близок к чёрному, а не серо-серый;
- основной текст на тёмном фоне близок к белому;
- muted text остаётся читаемым и проходит разумный contrast;
- status нельзя кодировать только цветом: всегда label/icon + color;
- thumbnail/poster имеет стабильное соотношение сторон;
- hover не является единственным способом получить информацию;
- keyboard focus видим;
- modal/inspector читабелен на 1366px desktop и mobile;
- dark/light theme допускаются позже, но semantic colors должны быть едины.

Нужны CSS design tokens:

```text
--bg
--surface
--text-primary
--text-secondary
--border
--accent
--success
--warning
--danger
```

Не разбрасывать случайные серые цвета по компонентам.

## 12. Dashboard

Главный `Обзор` должен стать редакционным dashboard, а не только счётчиками DB-status.

Показывать:

- `Сегодня` — что выйдет сегодня;
- `Следующие 7 дней` — количество и platform distribution;
- `Нужно проверить` — Inbox/Draft с warnings;
- `Готово к публикации`;
- `Проблемы`;
- мини-календарь/agenda;
- recent publication results.

Технические diagnostics/recovery остаются отдельными страницами.

## 13. Data model — направление

Не ломать существующую publication state machine.

Добавить к canonical content модель примерно такие поля/сущности:

```text
publication_kind: FEED | SHORT | STORY
content_format: TEXT_ONLY | IMAGE | CAROUSEL | VIDEO | VERTICAL_VIDEO | STORY_SEQUENCE
```

Media расширить metadata для video.

Для platform-specific rendition предусмотреть отдельную сущность/DTO, а не копировать целиком post на каждую соцсеть.

Story sequence имеет ordered media items.

Все новые типы всё равно проходят:

```text
DRAFT -> READY -> PUBLISHING -> PUBLISHED / PARTIAL / FAILED / RECOVERY_NEEDED
```

## 14. Capability matrix

Каждый platform adapter должен объявлять capability, которую использует UI и preflight:

```text
supportsFeed
supportsStories
supportsShortVideo
supportsImage
supportsVideo
supportsCarousel
maxMediaPerPublication
allowedMimeTypes
aspectRatioRules
durationRules
textRules
requiresPublicHttpsMedia
```

Конкретные значения проверяются при реализации на актуальной документации API площадки и затем подтверждаются live acceptance. Не хардкодить предполагаемые одинаковые ограничения для всех платформ.

## 15. Связь с Content Pipeline v2

Все входы Pipeline v2 должны уметь указать тип публикации и media:

CSV/XLSX v2 добавляет:

```text
publication_kind
content_format
media
```

ZIP bundle принимает изображения и видео.

Integration API принимает те же поля.

Google Drive / Яндекс Диск resolver ищет и image, и video assets.

Google Sheets template имеет отдельные колонки format/kind/media.

## 16. Этапы реализации

### CX3-001 — Visual Calendar shell

- новый nav `Календарь`;
- month/week/day/agenda;
- thumbnail/poster cards;
- дата/время/platform/status/source;
- open Content Inspector.

### CX3-002 — Content Library UX

- grid/list;
- Inbox/Draft/Ready/Scheduled/Published/Problems;
- Stories/Shorts filters;
- pagination/search;
- bulk selection.

### CX3-003 — Rich Media data model

- publication_kind/content_format;
- video metadata;
- story sequence;
- migrations/backfill старых постов в `FEED + IMAGE/CAROUSEL`.

### CX3-004 — Media player/viewer

- image viewer;
- video player;
- carousel viewer;
- 9:16 phone preview;
- story sequence player.

### CX3-005 — Platform capability/preflight

- capability DTO;
- UI warnings;
- adapter-specific supported formats;
- READY block при несовместимости.

### CX3-006 — Platform previews v2

- Feed/Image/Carousel;
- Video;
- Short/Reel;
- Story image/video;
- resolved platform text and safe-zone warnings.

### CX3-007 — Dashboard + contrast/design tokens

- editorial dashboard;
- contrast correction;
- semantic tokens;
- responsive inspector/calendar.

### CX3-008 — Video publication adapters

Реализовывать отдельно для каждой платформы, только после проверки актуального официального API. Story/short capability включать только там, где подтверждён реальный publish API и live acceptance.

## 17. Acceptance

Минимальный визуальный acceptance:

1. В системе 500 публикаций на 60 дней вперёд.
2. Среди них есть image feed, carousel, обычное video, vertical short, image story, video story и story sequence.
3. Month view остаётся читаемым и не зависает.
4. Week/day/agenda корректно показывают время и timezone.
5. Клик по любой карточке открывает Inspector с media viewer/player.
6. Story sequence проигрывается в правильном порядке.
7. Video poster и duration видны без открытия редактора.
8. Platform preview использует resolved text и media order.
9. Контраст текста проверен на основных страницах.
10. После refresh/restart календарь показывает тот же canonical state.
11. Старые image posts после migration продолжают работать.
12. Unsupported platform format блокируется preflight до внешнего POST.

## 18. Что не смешивать

- `Календарь` — пользовательское планирование контента.
- `Расписание` — технические QUEUE slots.
- `Журнал` — audit events.
- `Диагностика` — техническое состояние.

Эти понятия должны быть визуально и терминологически разделены.
