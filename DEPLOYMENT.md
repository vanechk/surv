# Развертывание системы СУРВ на production сервере

## Требования к серверу

- Ubuntu 20.04+ или CentOS 7+
- Node.js 18+
- PostgreSQL 13+
- PM2
- Nginx (опционально)

## Пошаговая инструкция развертывания

### 1. Подготовка сервера

```bash
# Обновление системы
sudo apt update && sudo apt upgrade -y

# Установка Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Установка PostgreSQL
sudo apt install postgresql postgresql-contrib -y

# Установка PM2 глобально
sudo npm install -g pm2

# Установка Git
sudo apt install git -y
```

### 2. Настройка базы данных PostgreSQL

```bash
# Переключение на пользователя postgres
sudo -u postgres psql

# В консоли PostgreSQL:
CREATE USER surv_user WITH ENCRYPTED PASSWORD 'your_secure_password';
CREATE DATABASE surv_database OWNER surv_user;
GRANT ALL PRIVILEGES ON DATABASE surv_database TO surv_user;
\q
```

### 3. Клонирование и настройка проекта

```bash
# Создание директории для проекта
sudo mkdir -p /var/www/surv-system
sudo chown $USER:$USER /var/www/surv-system

# Клонирование проекта
cd /var/www/surv-system
git clone <ваш-репозиторий> .

# Установка зависимостей
npm install

# Создание файла переменных окружения
cp .env.example .env
nano .env
```

### 4. Настройка переменных окружения (.env)

```env
# База данных PostgreSQL
DATABASE_URL="postgresql://surv_user:your_secure_password@localhost:5432/surv_database?schema=public"

# Настройки сессий
SESSION_SECRET="surv-production-secret-key-2025-very-long-and-secure"

# Настройки сервера
NODE_ENV=production
PORT=3001

# Настройки безопасности
SECURE_COOKIES=true
```

### 5. Настройка базы данных Prisma

```bash
# Генерация Prisma клиента
npx prisma generate

# Создание таблиц в базе данных
npx prisma db push

# Опционально: наполнение тестовыми данными
npx prisma db seed
```

### 6. Запуск через PM2

```bash
# Запуск приложения
pm2 start ecosystem.config.js --env production

# Сохранение конфигурации PM2
pm2 save

# Автозапуск PM2 при перезагрузке системы
pm2 startup
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME
```

### 7. Настройка Nginx (опционально)

```bash
# Установка Nginx
sudo apt install nginx -y

# Создание конфигурации для сайта
sudo nano /etc/nginx/sites-available/surv-system
```

Конфигурация Nginx:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Активация сайта
sudo ln -s /etc/nginx/sites-available/surv-system /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 8. Настройка SSL с Let's Encrypt (опционально)

```bash
# Установка Certbot
sudo apt install certbot python3-certbot-nginx -y

# Получение SSL сертификата
sudo certbot --nginx -d your-domain.com
```

## Команды для управления

### PM2 команды
```bash
# Просмотр статуса
pm2 status

# Просмотр логов
pm2 logs surv-system

# Перезапуск
pm2 restart surv-system

# Остановка
pm2 stop surv-system

# Удаление из PM2
pm2 delete surv-system
```

### База данных
```bash
# Резервная копия
pg_dump -U surv_user -h localhost surv_database > backup_$(date +%Y%m%d).sql

# Восстановление
psql -U surv_user -h localhost surv_database < backup_20250101.sql
```

## Обновление приложения

```bash
cd /var/www/surv-system
git pull origin main
npm install
npx prisma generate
npx prisma db push
pm2 restart surv-system
```

## Мониторинг

```bash
# Установка htop для мониторинга ресурсов
sudo apt install htop

# Мониторинг PM2
pm2 monit

# Просмотр логов Nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

## Безопасность

1. Настройте firewall:
```bash
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

2. Регулярно обновляйте систему:
```bash
sudo apt update && sudo apt upgrade -y
```

3. Создайте регулярные резервные копии базы данных

## Решение проблем

### Проблема с подключением к базе данных
```bash
# Проверка статуса PostgreSQL
sudo systemctl status postgresql

# Перезапуск PostgreSQL
sudo systemctl restart postgresql
```

### Проблема с PM2
```bash
# Полный перезапуск PM2
pm2 kill
pm2 start ecosystem.config.js --env production
```

### Проблема с портами
```bash
# Проверка занятых портов
sudo netstat -tulpn | grep :3001
``` 