# Подключение площадок

## Telegram

Credentials:

```json
{"botToken":"...","chatId":"@channel_or_id"}
```

Бот должен иметь право публиковать в канале. Поддерживается одно изображение и альбом до 10 изображений. Если текст длиннее Telegram caption, изображение/альбом публикуется первым, затем текст отдельным сообщением.

## MAX

Credentials:

```json
{"accessToken":"...","chatId":"..."}
```

Используется актуальный домен Bot API `platform-api2.max.ru`. Изображения передаются как публичные HTTPS URL. Поэтому `PUBLIC_BASE_URL` должен быть доступен серверу MAX.

## VK

Credentials:

```json
{"accessToken":"...","groupId":"123456","apiVersion":"5.199"}
```

Изображения загружаются через `photos.getWallUploadServer → upload → photos.saveWallPhoto`, затем выполняется `wall.post`. Для защиты от дублей в `wall.post` передаётся `guid = post.id`. На текущем API загрузка фото может требовать пользовательский токен: community token способен вернуть ошибку 27 на `photos.getWallUploadServer`.

## Instagram

Credentials:

```json
{"accessToken":"...","igUserId":"...","graphVersion":"vXX.X"}
```

Версия Graph API задаётся явно и не зашита в приложение, потому что Meta регулярно выводит версии из эксплуатации. V0.1 поддерживает один JPEG на пост: `/{ig-user-id}/media → /media_publish`. `PUBLIC_BASE_URL` должен быть публичным HTTPS URL, доступным серверам Meta.
