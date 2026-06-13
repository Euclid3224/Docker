# Развертывание на Veesp

Конфигурация запускает сайт, PostgreSQL и Caddy. База данных и Node.js
недоступны напрямую из интернета. Caddy автоматически получает и обновляет
HTTPS-сертификат после настройки DNS.

## Сервер

Рекомендуемая конфигурация Veesp:

- тариф VM 2;
- Ubuntu 24.04 LTS, x86_64;
- публичный IPv4-адрес;
- 1 vCore, 2 ГБ RAM, 40 ГБ NVMe.

## DNS в REG.RU

После создания VPS скопируйте его IPv4-адрес и создайте в DNS-зоне домена:

```text
Тип: A
Имя: @
Значение: IPv4-адрес VPS
```

Для `www` можно создать:

```text
Тип: CNAME
Имя: www
Значение: teplayapekarnya61.ru.
```

Удалите конфликтующие записи `A` и `AAAA`, ведущие на старый хостинг.

## Подготовка Ubuntu

Подключитесь к серверу по SSH:

```bash
ssh root@IP_СЕРВЕРА
```

Установите Docker и Git:

```bash
apt update
apt install -y docker.io docker-compose-v2 git ufw
systemctl enable --now docker

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
```

Порты `3000` и `5432` открывать не нужно.

## Установка сайта

```bash
git clone https://github.com/Euclid3224/Docker.git /opt/bakery
cd /opt/bakery/deploy
cp .env.example .env
chmod 600 .env
nano .env
```

В `.env` укажите домен и два разных случайных пароля. Для PostgreSQL
используйте буквы и цифры без пробелов, двоеточий и символа `@`.

Случайные значения можно получить так:

```bash
openssl rand -hex 32
```

Запустите Stack. Сервис `migrate` автоматически создаст таблицы и импортирует
товары только при пустой базе. При обновлениях существующие остатки и заказы не
перезаписываются.

Для запуска из командной строки:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app caddy
```

Адреса:

- сайт: `https://teplayapekarnya61.ru`;
- кабинет владельца: `https://teplayapekarnya61.ru/admin/`.

После первого входа смените пароль администратора в кабинете.

## Обновление

```bash
cd /opt/bakery
git pull --ff-only
cd deploy
docker compose up -d --build
```

## Резервная копия

```bash
cd /opt/bakery/deploy
mkdir -p backups
docker compose exec -T postgres \
  pg_dump -U bakery_user -d bakery -Fc > "backups/bakery-$(date +%F).dump"
```

Каталог `backups` исключен из Git. Копии нужно регулярно скачивать с VPS на
отдельное устройство.
