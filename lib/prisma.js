const { PrismaClient } = require('@prisma/client');

// Создаем единственный экземпляр Prisma клиента
const globalForPrisma = globalThis;

const prisma = globalForPrisma.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'error', 'warn'] 
    : ['error'],
  
  // Настройки подключения
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  }
});

// В режиме разработки сохраняем клиент в global для предотвращения пересоздания
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Функция для корректного отключения при завершении приложения
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma; 