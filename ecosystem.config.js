module.exports = {
  apps: [{
    name: 'surv-system',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001
    }
  }],

  deploy: {
    production: {
      user: 'root', // или ваш пользователь на сервере
      host: ['your-server-ip'], // замените на IP вашего сервера
      ref: 'origin/main',
      repo: 'git@github.com:username/surv-system.git', // замените на ваш репозиторий
      path: '/var/www/surv-system',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && npx prisma generate && npx prisma db push && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
}; 