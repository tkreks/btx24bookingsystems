# Развёртывание тестового стенда

Тестовый домен: **https://testapp.1-app.ru**. DNS указывает на внешний IP сервера, nginx
настроен через ispmanager на этом же сервере. Приложение — контейнер `app` (порт `3080`).

## nginx (ispmanager → сайт testapp.1-app.ru → конфигурация)
Сертификат — Let's Encrypt средствами ispmanager. Проксирование:

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    client_max_body_size 10m;
}
```

Важно для Битрикс24:
- **Не добавлять** `X-Frame-Options` и `Content-Security-Policy: frame-ancestors 'self'`:
  приложение открывается в iframe портала. Если ispmanager добавляет их по умолчанию, отключите.
- Портал открывает обработчик **POST-запросом**, поэтому `location /` должен пропускать POST.
- Только HTTPS: Битрикс24 не откроет приложение по HTTP.

## Приложение
В `.env`: `APP_BASE_URL=https://testapp.1-app.ru`. Если nginx на том же хосте, порт приложения
можно не публиковать наружу: `APP_HOST_BIND=127.0.0.1`.

```bash
docker compose up -d --build
curl -s https://testapp.1-app.ru/api/health
```
