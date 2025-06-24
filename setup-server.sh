#!/bin/bash

# Скрипт для первоначальной настройки сервера под систему СУРВ
# Использование: ./setup-server.sh [server_ip] [user] [db_password]

set -e

SERVER_IP=${1:-"your-server-ip"}
SERVER_USER=${2:-"root"}
DB_PASSWORD=${3:-$(openssl rand -base64 12)}

echo "🔧 Настройка сервера для системы СУРВ..."
echo "📡 Сервер: $SERVER_USER@$SERVER_IP"
echo "🔐 Пароль БД: $DB_PASSWORD"

# Функция для выполнения команд на сервере
run_remote() {
    ssh $SERVER_USER@$SERVER_IP "$1"
}

echo "📦 Обновляем систему..."
run_remote "apt update && apt upgrade -y"

echo "🟢 Устанавливаем Node.js 18..."
run_remote "curl -fsSL https://deb.nodesource.com/setup_18.x | bash -"
run_remote "apt-get install -y nodejs"

echo "🐘 Устанавливаем PostgreSQL..."
run_remote "apt install postgresql postgresql-contrib -y"

echo "🚀 Устанавливаем PM2..."
run_remote "npm install -g pm2"

echo "📁 Устанавливаем дополнительные утилиты..."
run_remote "apt install git htop ufw rsync -y"

echo "🗄️ Настраиваем PostgreSQL..."

# Настройка PostgreSQL
run_remote "systemctl start postgresql"
run_remote "systemctl enable postgresql"

# Создание пользователя и базы данных
run_remote "sudo -u postgres psql -c \"CREATE USER surv_user WITH ENCRYPTED PASSWORD '$DB_PASSWORD';\""
run_remote "sudo -u postgres psql -c \"CREATE DATABASE surv_database OWNER surv_user;\""
run_remote "sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE surv_database TO surv_user;\""

echo "📁 Создаем директорию проекта..."
run_remote "mkdir -p /var/www/surv-system"
run_remote "chown $SERVER_USER:$SERVER_USER /var/www/surv-system"

echo "🔥 Настраиваем firewall..."
run_remote "ufw allow ssh"
run_remote "ufw allow 3001"
run_remote "ufw --force enable"

echo "🎯 Создаем файл с паролем базы данных..."
run_remote "echo 'DATABASE_PASSWORD=$DB_PASSWORD' > /root/surv-db-password.txt"
run_remote "chmod 600 /root/surv-db-password.txt"

echo "✅ Сервер настроен!"
echo ""
echo "📋 Информация:"
echo "   🗄️ База данных: surv_database"
echo "   👤 Пользователь БД: surv_user"
echo "   🔐 Пароль БД: $DB_PASSWORD"
echo "   📁 Путь проекта: /var/www/surv-system"
echo ""
echo "🚀 Теперь можно запустить развертывание:"
echo "   ./deploy.sh $SERVER_IP $SERVER_USER"
echo ""
echo "⚠️ ВАЖНО: Пароль базы данных сохранен в /root/surv-db-password.txt на сервере" 