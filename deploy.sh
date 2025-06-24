#!/bin/bash

# Скрипт для развертывания системы СУРВ на production сервере
# Использование: ./deploy.sh [server_ip] [user]

set -e

SERVER_IP=${1:-"your-server-ip"}
SERVER_USER=${2:-"root"}
PROJECT_NAME="surv-system"
PROJECT_PATH="/var/www/$PROJECT_NAME"

echo "🚀 Начинаем развертывание системы СУРВ..."
echo "📡 Сервер: $SERVER_USER@$SERVER_IP"
echo "📁 Путь: $PROJECT_PATH"

# Функция для выполнения команд на сервере
run_remote() {
    ssh $SERVER_USER@$SERVER_IP "$1"
}

# Функция для копирования файлов
copy_files() {
    rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '*.xlsx' --exclude '.env*' . $SERVER_USER@$SERVER_IP:$PROJECT_PATH/
}

echo "📦 Копируем файлы на сервер..."
copy_files

echo "🔧 Настраиваем проект на сервере..."

# Основные команды настройки
run_remote "cd $PROJECT_PATH && npm install"
run_remote "cd $PROJECT_PATH && npx prisma generate"

echo "🗄️ Настраиваем базу данных..."

# Проверка существования .env файла
if run_remote "test -f $PROJECT_PATH/.env"; then
    echo "✅ Файл .env уже существует"
else
    echo "⚠️ Создайте файл .env на сервере с настройками базы данных"
    echo "Пример настроек:"
    echo "DATABASE_URL=\"postgresql://surv_user:password@localhost:5432/surv_database?schema=public\""
    echo "SESSION_SECRET=\"your-secret-key\""
    echo "NODE_ENV=production"
    echo "PORT=3001"
    echo "SECURE_COOKIES=true"
    
    # Создаем базовый .env файл
    run_remote "cat > $PROJECT_PATH/.env << 'EOF'
DATABASE_URL=\"postgresql://surv_user:CHANGE_PASSWORD@localhost:5432/surv_database?schema=public\"
SESSION_SECRET=\"surv-production-secret-key-2025-$(openssl rand -hex 32)\"
NODE_ENV=production
PORT=3001
SECURE_COOKIES=true
EOF"
    echo "📝 Создан базовый .env файл. ОБЯЗАТЕЛЬНО измените пароль базы данных!"
fi

# Применение миграций базы данных
echo "🔄 Применяем изменения в базе данных..."
run_remote "cd $PROJECT_PATH && npx prisma db push" || echo "⚠️ Ошибка применения изменений БД. Возможно, нужно сначала настроить PostgreSQL"

echo "🚀 Запускаем приложение через PM2..."

# Остановка и удаление старой версии (если есть)
run_remote "pm2 delete $PROJECT_NAME 2>/dev/null || true"

# Запуск новой версии
run_remote "cd $PROJECT_PATH && pm2 start ecosystem.config.js --env production"

# Сохранение конфигурации PM2
run_remote "pm2 save"

# Настройка автозапуска PM2 (если ещё не настроено)
run_remote "pm2 startup systemd 2>/dev/null || true"

echo "📊 Проверяем статус приложения..."
run_remote "pm2 status"

echo "🎉 Развертывание завершено!"
echo ""
echo "📋 Полезные команды для управления:"
echo "   Просмотр логов:     ssh $SERVER_USER@$SERVER_IP 'pm2 logs $PROJECT_NAME'"
echo "   Перезапуск:         ssh $SERVER_USER@$SERVER_IP 'pm2 restart $PROJECT_NAME'"
echo "   Остановка:          ssh $SERVER_USER@$SERVER_IP 'pm2 stop $PROJECT_NAME'"
echo "   Мониторинг:         ssh $SERVER_USER@$SERVER_IP 'pm2 monit'"
echo ""
echo "🌐 Приложение должно быть доступно по адресу: http://$SERVER_IP:3001"
echo "🔐 Логин: admin, Пароль: Yana"
echo ""
echo "⚠️ ВАЖНО:"
echo "   1. Измените пароль базы данных в файле .env"
echo "   2. Настройте firewall: ufw allow 3001"
echo "   3. Рассмотрите использование Nginx для reverse proxy"
echo "   4. Настройте SSL сертификат для HTTPS" 