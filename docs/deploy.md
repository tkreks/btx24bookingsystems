# Развёртывание тестового стенда

Тестовый домен: **https://testapp.1-app.ru**. DNS указывает на внешний IP, трафик попадает на
сервер разработки `192.168.10.15` в **Nginx Proxy Manager** (контейнер `nginx-proxy-manager`,
админка `http://192.168.10.15:81`). Приложение — контейнер `app` на порту `3080` хоста.

NPM работает в своей docker-сети (`npm_default`), поэтому проксирует на IP хоста, а не на
`127.0.0.1`. Так же устроены остальные хосты в NPM.

## Proxy Host в NPM
**Details**
| Поле | Значение |
|---|---|
| Domain Names | `testapp.1-app.ru` |
| Scheme | `http` |
| Forward Hostname / IP | `192.168.10.15` |
| Forward Port | `3080` |
| Cache Assets | выкл |
| Block Common Exploits | вкл |
| Websockets Support | вкл |

**SSL:** Let's Encrypt, Force SSL — вкл, HTTP/2 — вкл, HSTS — пока выкл (трудно откатить).

**Advanced → Custom Nginx Configuration:**
```nginx
client_max_body_size 10m;
proxy_read_timeout 120s;
proxy_send_timeout 120s;
```

Важно для Битрикс24:
- **Не добавлять** `X-Frame-Options` и `Content-Security-Policy: frame-ancestors 'self'`:
  приложение открывается в iframe портала.
- Портал открывает обработчик **POST-запросом** — прокси должен пропускать POST на `/`.
- Только HTTPS: Битрикс24 не откроет приложение по HTTP.

## Приложение
В `.env`: `APP_BASE_URL=https://testapp.1-app.ru`. `APP_HOST_BIND` оставить `0.0.0.0`:
NPM ходит на IP хоста. Порт `3080` не пробрасывать на роутере наружу — только через NPM.

```bash
docker compose up -d --build
curl -s https://testapp.1-app.ru/api/health
```

## Прототип (для справки)
Прототип на Node-RED работает на **другом сервере** (ispmanager + nginx, `app.alatyrbanya.ru`).
Этот стенд к нему не относится.
