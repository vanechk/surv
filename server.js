// Загрузка переменных окружения
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const moment = require('moment');
const ExcelJS = require('exceljs');
const path = require('path');
const prisma = require('./lib/prisma');

const app = express();

// Настройка сессий с переменными окружения
app.use(session({
  secret: process.env.SESSION_SECRET || 'surv-schedule-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production' && process.env.SECURE_COOKIES === 'true',
    maxAge: 24 * 60 * 60 * 1000 // 24 часа
  }
}));

app.use(express.json());
app.use(express.static('public'));

// Учетные данные (в реальном проекте должны храниться в БД с хешированием)
const AUTH_CREDENTIALS = {
  username: 'admin',
  password: 'Yana'
};

// Middleware для проверки авторизации
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  } else {
    return res.status(401).json({ success: false, error: 'Требуется авторизация' });
  }
}

// Производственный календарь 2025 года (40-часовая неделя, с учётом предпраздничных сокращённых дней)
const WORKING_HOURS_2025 = {
  1: 136, // 17 раб. дн.
  2: 160, // 20 раб. дн.
  3: 167, // 21 раб. дн. (-1 ч 7 марта)
  4: 175, // 22 раб. дн.
  5: 144, // 18 раб. дн.
  6: 151, // 19 раб. дн. (-1 ч 11 июня)
  7: 184, // 23 раб. дн.
  8: 168, // 21 раб. дн.
  9: 176, // 22 раб. дн.
  10: 184, // 23 раб. дн.
  11: 151, // 19 раб. дн. (-1 ч 3 ноября)
  12: 176  // 22 раб. дн.
};

// Праздничные дни 2025 года
const HOLIDAYS_2025 = {
  // Январь
  '2025-01-01': 'Новый год',
  '2025-01-02': 'Новогодние каникулы',
  '2025-01-03': 'Новогодние каникулы',
  '2025-01-04': 'Новогодние каникулы',
  '2025-01-05': 'Новогодние каникулы',
  '2025-01-06': 'Новогодние каникулы',
  '2025-01-07': 'Рождество Христово',
  '2025-01-08': 'Новогодние каникулы',
  
  // Февраль
  '2025-02-23': 'День защитника Отечества',
  
  // Март
  '2025-03-08': 'Международный женский день',
  
  // Май
  '2025-05-01': 'Праздник Весны и Труда',
  '2025-05-02': 'Праздник Весны и Труда (перенос)',
  '2025-05-09': 'День Победы',
  
  // Июнь
  '2025-06-12': 'День России',
  '2025-06-13': 'День России (перенос)',
  
  // Ноябрь
  '2025-11-04': 'День народного единства',
  
  // Декабрь
  '2025-12-31': 'Новый год (предпраздничный день)'
};

// Предпраздничные дни (сокращенные на 1 час)
const PRE_HOLIDAY_DAYS_2025 = {
  '2025-02-22': 'Предпраздничный день', // Перед 23 февраля
  '2025-03-07': 'Предпраздничный день', // Перед 8 марта
  '2025-04-30': 'Предпраздничный день', // Перед 1 мая
  '2025-05-08': 'Предпраздничный день', // Перед 9 мая
  '2025-06-11': 'Предпраздничный день', // Перед 12 июня
  '2025-11-03': 'Предпраздничный день', // Перед 4 ноября
  '2025-12-30': 'Предпраздничный день'  // Перед 31 декабря
};

// Проверка является ли день праздничным
function isHoliday(dateStr) {
  return HOLIDAYS_2025.hasOwnProperty(dateStr);
}

// Проверка является ли день предпраздничным
function isPreHoliday(dateStr) {
  return PRE_HOLIDAY_DAYS_2025.hasOwnProperty(dateStr);
}

// Типы смен с цветами для Excel
const SHIFT_TYPES = {
  DAY: { name: 'Дневная смена', hours: 8.25, start: '09:00', end: '18:00', location: 'офис', color: 'FF10B981' }, // Зеленый
  MONDAY_HOME: { name: 'Понедельник из дома', hours: 10.25, start: '11:00', end: '22:00', location: 'дом', color: 'FF8B5CF6' }, // Фиолетовый
  DUTY_HOME: { name: 'Дежурство из дома', hours: 9.25, start: '16:00', end: '02:00', location: 'дом', color: 'FF1E40AF' }, // Темно-синий
  WEEKEND: { name: 'Выходной дежурство', hours: 9.25, start: '13:00', end: '23:00', location: 'дом', color: 'FFEF4444' }, // Красный для выходных дежурств
  FRIDAY: { name: 'Пятница', hours: 7.25, start: '09:00', end: '16:45', location: 'офис', color: 'FF059669' }, // Темно-зеленый
  PRE_HOLIDAY: { name: 'Предпраздничный день', hours: 7.25, start: '09:00', end: '17:00', location: 'офис', color: 'FFF59E0B' }, // Оранжевый для предпраздничных
  SUPERVISOR_DAY: { name: 'Руководитель будни', hours: 8.0, start: '09:00', end: '18:00', location: 'офис', color: 'FF374151' }, // Серый
  SUPERVISOR_FRIDAY: { name: 'Руководитель пятница', hours: 8.0, start: '09:00', end: '17:00', location: 'офис', color: 'FF374151' }, // Серый
  SUPERVISOR_PRE_HOLIDAY: { name: 'Руководитель предпраздничный', hours: 7.0, start: '09:00', end: '17:00', location: 'офис', color: 'FF6B7280' }, // Светло-серый
  OFF: { name: 'Выходной', hours: 0, start: '', end: '', location: '', color: 'FFE5E7EB' } // Очень светло-серый
};

// Система пожеланий сотрудников
class EmployeePreferences {
  constructor() {
    this.preferences = new Map();
  }

  setPreference(employee, date, type, reason = '') {
    if (!this.preferences.has(employee)) {
      this.preferences.set(employee, new Map());
    }
    this.preferences.get(employee).set(date, { type, reason });
  }

  getPreference(employee, date) {
    return this.preferences.get(employee)?.get(date) || null;
  }

  // Предустановленные пожелания для демонстрации
  setupDemo(employees, year, month) {
    // Убираем автоматические пожелания - пользователь добавляет их сам
        return;
  }
}

// Улучшенная система счетчиков справедливости
class FairnessTracker {
  constructor(employees) {
    this.employees = employees;
    this.reset();
  }

  reset() {
    this.stats = {};
    this.employees.forEach(emp => {
      this.stats[emp] = {
        totalHours: 0,
        workDays: 0,
        weekendShifts: 0,
        dutyShifts: 0, // Только DUTY_HOME
        mondayDutyShifts: 0, // Дежурства в понедельник
        mondayHomeShifts: 0, // Удаленка в понедельник
        nightShifts: 0,
        offDays: 0,
        consecutiveWorkDays: 0,
        maxConsecutiveWork: 0,
        vacationDays: 0,
        weekendWorkDays: 0, // Работа в субботу/воскресенье
        lastWeekendWork: null // Дата последней работы в выходные
      };
    });
  }

  updateStats(employee, shiftType, hours) {
    const stats = this.stats[employee];
    
    if (shiftType === 'OFF') {
      stats.offDays++;
      stats.consecutiveWorkDays = 0;
    } else if (shiftType === 'vacation') {
      stats.vacationDays++;
      stats.offDays++;
      stats.consecutiveWorkDays = 0;
    } else {
      stats.totalHours += hours;
      stats.workDays++;
      stats.consecutiveWorkDays++;
      stats.maxConsecutiveWork = Math.max(stats.maxConsecutiveWork, stats.consecutiveWorkDays);

      // Разделяем типы дежурств
      if (shiftType === 'WEEKEND') {
        stats.weekendShifts++;
        stats.weekendWorkDays++;
      }
      if (shiftType === 'DUTY_HOME') {
        stats.dutyShifts++;
        stats.nightShifts++;
      }
      if (shiftType === 'MONDAY_HOME') {
        stats.mondayHomeShifts++;
      }
    }
  }

  // НОВАЯ функция: обновление статистики работы в выходные
  updateWeekendWork(employee, date) {
    this.stats[employee].lastWeekendWork = date;
    this.stats[employee].weekendWorkDays++;
  }

  // Вычисляем "балл справедливости" для выбора сотрудника на смену
  calculateFairnessScore(employee, shiftType, dateKey = null) {
    const stats = this.stats[employee];
    let score = 0;

    // Базовый приоритет - меньше часов = больше приоритет
    score += (200 - stats.totalHours) * 10;

    // Специфические бонусы по типу смены с УЛУЧШЕННОЙ ЛОГИКОЙ
    switch (shiftType) {
      case 'WEEKEND':
        // Приоритет тем, кто меньше работал в выходные
        score += (5 - stats.weekendWorkDays) * 100; // Сильно повышаем вес
        
        // Бонус если давно не работал в выходные
        if (stats.lastWeekendWork) {
          const daysSinceLastWeekend = moment(dateKey).diff(moment(stats.lastWeekendWork), 'days');
          score += daysSinceLastWeekend * 5;
        } else {
          score += 50; // Никогда не работал в выходные
        }
        break;
        
      case 'DUTY_HOME':
        // Равномерное распределение дежурств
        score += (3 - stats.dutyShifts) * 80;
        break;
        
      case 'MONDAY_HOME':
        // Равномерное распределение удаленки в понедельник
        score += (2 - stats.mondayHomeShifts) * 60;
        break;
    }

    // Штраф за много подряд рабочих дней
    if (stats.consecutiveWorkDays >= 5) {
      score -= stats.consecutiveWorkDays * 150; // Увеличиваем штраф
    }

    // Бонус за меньше выходных дней
    score += (30 - stats.offDays) * 5;

    // НОВЫЙ фактор: баланс общей нагрузки
    const avgHours = this.getAverageHours();
    const deviation = stats.totalHours - avgHours;
    score -= deviation * 15; // Штраф за отклонение от средней нагрузки

    return score;
  }

  // Новая функция: получение средних часов
  getAverageHours() {
    const totalHours = this.employees.reduce((sum, emp) => sum + this.stats[emp].totalHours, 0);
    return totalHours / this.employees.length;
  }

  // НОВАЯ функция: получение кандидатов для балансировки нагрузки
  getCandidatesForBalancing(shiftType) {
    return this.employees.sort((a, b) => {
      const scoreA = this.calculateFairnessScore(a, shiftType);
      const scoreB = this.calculateFairnessScore(b, shiftType);
      return scoreB - scoreA;
    });
  }

  getDetailedStats() {
    return this.stats;
  }

  // НОВАЯ функция: проверка необходимости принудительной балансировки
  needsRebalancing() {
    const avgHours = this.getAverageHours();
    const maxDeviation = Math.max(...this.employees.map(emp => 
      Math.abs(this.stats[emp].totalHours - avgHours)
    ));
    
    // Если отклонение больше 10 часов - нужна перебалансировка
    return maxDeviation > 10;
  }
}

// Функция для загрузки сотрудников из БД
async function loadEmployeesFromDatabase() {
  try {
    const employees = await prisma.employee.findMany({
      where: { isActive: true },
      orderBy: [
        { position: 'desc' }, // Сначала руководители
        { fullName: 'asc' }
      ]
    });

    return employees.map(emp => ({
      name: emp.fullName,
      position: emp.position,
      employmentDate: emp.employmentDate ? emp.employmentDate.toISOString().split('T')[0] : null,
      phone: emp.phone,
      email: emp.email
    }));
  } catch (error) {
    console.error('Ошибка загрузки сотрудников из БД:', error);
    return [];
  }
}

// Генерация случайных имен сотрудников (запасной вариант)
function generateRandomNames(count) {
  const firstNames = ['Александр', 'Анна', 'Михаил', 'Елена', 'Дмитрий', 'Ольга', 'Сергей', 'Татьяна'];
  const lastNames = ['Иванов', 'Петрова', 'Сидоров', 'Козлова', 'Смирнов', 'Новикова', 'Лебедев', 'Морозова'];
  
  const names = [];
  for (let i = 0; i < count; i++) {
    const firstName = firstNames[i % firstNames.length];
    const lastName = lastNames[i % lastNames.length];
    names.push(`${firstName} ${lastName}`);
  }
  return names;
}

// Проверка минимального отдыха между сменами (12 часов)
function hasMinimumRest(lastShiftEnd, currentShiftStart) {
  if (!lastShiftEnd || !currentShiftStart) return true;
  
  const lastEnd = moment(lastShiftEnd, 'YYYY-MM-DD HH:mm');
  const currentStart = moment(currentShiftStart, 'YYYY-MM-DD HH:mm');
  
  const restHours = currentStart.diff(lastEnd, 'hours', true);
  return restHours >= 12;
}

// Проверка еженедельного отдыха (42 часа)
function hasWeeklyRest(schedule, employee, weekStart) {
  const weekEnd = moment(weekStart).add(6, 'days');
  let totalWorkHours = 0;
  
  for (let day = moment(weekStart); day.isSameOrBefore(weekEnd); day.add(1, 'day')) {
    const dayKey = day.format('YYYY-MM-DD');
    const shift = schedule[employee][dayKey];
    if (shift && shift.type !== 'OFF') {
      totalWorkHours += shift.hours;
    }
  }
  
  return (7 * 24) - totalWorkHours >= 42;
}

// Список смен для каждого типа дня
function getDailyShiftTemplate(dayOfWeek, dateStr) {
  // Проверяем праздники
  if (isHoliday(dateStr)) {
    // Праздники: только 1 дежурство (как выходные)
    return ['WEEKEND'];
  }

  // 0 – вс, 6 – сб
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    // Выходные: только 1 дежурство
    return ['WEEKEND'];
  }

  if (dayOfWeek === 1) {
    // Понедельник: СТРОГО 2+2 смены
    // 2 удаленщика до 22:00 + 2 дежурных до 02:00 + 3 стандартно
    return [
      'MONDAY_HOME', 'MONDAY_HOME',                    // 2 удаленщика (11:00-22:00)
      'DUTY_HOME', 'DUTY_HOME',                        // 2 дежурных (16:00-02:00)
      'DAY', 'DAY', 'DAY'                             // 3 стандартно (09:00-18:00)
    ];
  }

  if (dayOfWeek === 5) {
    // Пятница: короткий день + 1 дежурство
    if (isPreHoliday(dateStr)) {
      // Предпраздничный день - на час короче обычного
      return [
        'PRE_HOLIDAY', 'PRE_HOLIDAY', 'PRE_HOLIDAY', 'PRE_HOLIDAY',
        'PRE_HOLIDAY', 'PRE_HOLIDAY', 'DUTY_HOME'     // 6 предпраздничных + 1 дежурство
      ];
    } else {
      // Обычная пятница - короткий день + 1 дежурство
      return [
        'FRIDAY', 'FRIDAY', 'FRIDAY', 'FRIDAY',
        'FRIDAY', 'FRIDAY', 'DUTY_HOME'               // 6 пятница + 1 дежурство 16:00-02:00
      ];
    }
  }

  // Обычные будни (вт-чт): стандартно + минимум 1 дежурство
  if (isPreHoliday(dateStr)) {
    // Предпраздничный будний день
    return [
      'PRE_HOLIDAY', 'PRE_HOLIDAY', 'PRE_HOLIDAY', 'PRE_HOLIDAY',
      'PRE_HOLIDAY', 'PRE_HOLIDAY', 'DUTY_HOME'       // 6 предпраздничных + 1 дежурство
    ];
  } else {
    // Обычные будни: 6 стандартно + 1 дежурство
    return [
      'DAY', 'DAY', 'DAY', 'DAY', 'DAY', 'DAY',       // 6 стандартно (09:00-18:00)
      'DUTY_HOME'                                     // 1 дежурство (16:00-02:00)
    ];
  }
}

// Функция для расчета скорректированной нормы часов с учетом отпусков
function calculateAdjustedTargetHours(baseTargetHours, schedule, employee, year, month) {
  let vacationDays = 0;
  
  // Подсчитываем дни отпуска
  Object.values(schedule[employee]).forEach(shift => {
    if (shift.type === 'vacation') {
      vacationDays++;
    }
  });
  
  if (vacationDays === 0) {
    return baseTargetHours;
  }
  
  // Рассчитываем средние часы рабочего дня в месяце
  const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
  
  // Считаем рабочие дни в месяце (исключая выходные и праздники)
  let workingDays = 0;
  let preHolidayDays = 0;
  
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    const dateStr = date.format('YYYY-MM-DD');
    const dayOfWeek = date.day();
    
    // Пропускаем выходные и праздники
    if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateStr)) {
      continue;
    }
    
    if (isPreHoliday(dateStr)) {
      preHolidayDays++;
    } else {
      workingDays++;
    }
  }
  
  // Рассчитываем средние часы в день
  // Обычные дни: 8.25ч, предпраздничные: 7.25ч
  const totalNormalHours = workingDays * 8.25 + preHolidayDays * 7.25;
  const averageHoursPerDay = totalNormalHours / (workingDays + preHolidayDays);
  
  // Вычитаем часы за дни отпуска
  const hoursToSubtract = vacationDays * averageHoursPerDay;
  const adjustedTarget = baseTargetHours - hoursToSubtract;
  
  return Math.max(0, Math.round(adjustedTarget * 4) / 4); // Округляем до 0.25
}

// Функция для внесения минимальных изменений в существующий график
function applyMinimalChangesToSchedule(existingSchedule, newPreferences, employees, year, month) {
  console.log('🔄 Применяем минимальные изменения к существующему графику...');
  console.log('📋 Полученные пожелания:', JSON.stringify(newPreferences, null, 2));
  
  const supervisor = employees[0];
  const staff = employees.slice(1);
  const targetHours = WORKING_HOURS_2025[month];
  
  // Определяем "сегодняшнюю" дату для контекста графика
  // Если мы работаем с текущим месяцем - используем реальную дату
  // Если с будущим месяцем - используем первое число месяца
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  
  let referenceDate;
  if (year === currentYear && month === currentMonth) {
    // Текущий месяц - используем сегодняшнюю дату
    referenceDate = new Date();
    referenceDate.setHours(0, 0, 0, 0);
  } else if (year > currentYear || (year === currentYear && month > currentMonth)) {
    // Будущий месяц - начинаем с первого числа
    referenceDate = new Date(year, month - 1, 1);
  } else {
    // Прошедший месяц - все даты считаем доступными для изменений
    referenceDate = new Date(year, month - 1, 1);
  }
  
  console.log(`📅 Эталонная дата для ${year}-${month}: ${referenceDate.toISOString().split('T')[0]} (текущая дата: ${now.toISOString().split('T')[0]})`);
  
  // Создаем глубокую копию существующего графика
      const schedule = {};
  employees.forEach(emp => {
    schedule[emp] = {};
    // existingSchedule имеет структуру с полем schedule
    const empSchedule = existingSchedule.schedule[emp] || {};
    Object.keys(empSchedule).forEach(date => {
      schedule[emp][date] = { ...empSchedule[date] };
    });
    
    // Проверяем что у сотрудника есть полный график на весь месяц
    const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      if (!schedule[emp][dateKey]) {
        console.warn(`⚠️ Отсутствует смена для ${emp} на ${dateKey}, устанавливаем выходной`);
        schedule[emp][dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
      }
    }
  });
  
  const changes = [];
  
  // 1. Сначала применяем изменения в пожеланиях
  Object.entries(newPreferences).forEach(([employee, empPrefs]) => {
    console.log(`👤 Обрабатываем пожелания для ${employee}:`, empPrefs);
    
    if (employee === supervisor) {
      console.log(`⏭️ Пропускаем руководителя: ${employee}`);
      return; // Пропускаем руководителя
    }
    
    Object.entries(empPrefs).forEach(([date, pref]) => {
      console.log(`📅 Обрабатываем дату ${date} для ${employee}, тип: ${pref.type}`);
      
      // Проверяем, что дата в будущем или сегодня (относительно контекста графика)
      const changeDate = new Date(date);
      if (changeDate < referenceDate) {
        console.log(`⏭️ Пропускаем дату ${date} для ${employee} (раньше эталонной даты)`);
        return;
      }
      
      // Проверяем что у сотрудника есть график на эту дату
      if (!schedule[employee] || !schedule[employee][date]) {
        console.warn(`⚠️ Нет данных графика для ${employee} на ${date}`);
        return;
      }
      
      const currentShift = schedule[employee][date];
      console.log(`📊 Текущая смена для ${employee} на ${date}:`, currentShift);
      
      if (pref.type === 'vacation') {
        // Устанавливаем отпуск
        if (currentShift.type !== 'vacation') {
          console.log(`🏖️ Устанавливаем отпуск для ${employee} на ${date}`);
          changes.push({
            employee,
            date,
            oldShift: { ...currentShift },
            newShift: { type: 'vacation', hours: 0, start: '', end: '', location: '' },
            reason: 'Добавлен отпуск по пожеланию'
          });
          schedule[employee][date] = { type: 'vacation', hours: 0, start: '', end: '', location: '' };
        }
      } else if (pref.type === 'no_weekend') {
        // Убираем работу в выходные
        const dateObj = new Date(date);
        const dayOfWeek = dateObj.getDay(); // 0 = воскресенье, 6 = суббота
        
        console.log(`📅 Дата ${date}: день недели = ${dayOfWeek} (0=Вс, 1=Пн...6=Сб)`);
        console.log(`🎯 Проверяем выходной: dayOfWeek === 0 || dayOfWeek === 6: ${dayOfWeek === 0 || dayOfWeek === 6}`);
        console.log(`💼 Тип смены не OFF: ${currentShift.type !== 'OFF'}`);
        
        if ((dayOfWeek === 0 || dayOfWeek === 6) && currentShift.type !== 'OFF') {
          console.log(`🔄 Ищем замену для ${employee} на выходной день ${date}`);
          
          // Ищем замену среди сотрудников, которые работают в выходные
          const replacementCandidate = employees
            .filter(e => e !== employee && e !== supervisor) // Исключаем самого сотрудника и руководителя
            .find(candidateEmp => {
              const candidateShift = schedule[candidateEmp]?.[date];
              if (!candidateShift || candidateShift.type === 'OFF') {
                // Кандидат свободен в этот день - идеальная замена
                return true;
              }
              return false;
            });
          
          // Если не нашли свободного, ищем для обмена субботы с воскресеньем
          let swapCandidate = null;
          if (!replacementCandidate && (dayOfWeek === 6 || dayOfWeek === 0)) {
            const targetDay = dayOfWeek === 6 ? 0 : 6; // суббота -> воскресенье или наоборот
            const currentDate = new Date(date);
            
            // Ищем соседний выходной день
            let swapDate = null;
            if (dayOfWeek === 6) {
              // Суббота -> воскресенье (следующий день)
              const nextDay = new Date(currentDate);
              nextDay.setDate(nextDay.getDate() + 1);
              if (nextDay.getDay() === 0) {
                swapDate = nextDay.toISOString().split('T')[0];
          }
        } else {
              // Воскресенье -> суббота (предыдущий день)
              const prevDay = new Date(currentDate);
              prevDay.setDate(prevDay.getDate() - 1);
              if (prevDay.getDay() === 6) {
                swapDate = prevDay.toISOString().split('T')[0];
              }
            }
            
            if (swapDate) {
              // Ищем кого можно поменять местами
              swapCandidate = employees
                .filter(e => e !== employee && e !== supervisor)
                .find(candidateEmp => {
                  const candidateCurrentShift = schedule[candidateEmp]?.[date];
                  const candidateSwapShift = schedule[candidateEmp]?.[swapDate];
                  
                  // Кандидат работает в текущий день и свободен в день для обмена
                  return candidateCurrentShift && candidateCurrentShift.type !== 'OFF' &&
                         candidateSwapShift && candidateSwapShift.type === 'OFF';
                });
              
              if (swapCandidate) {
                console.log(`🔄 Найден кандидат для обмена выходными: ${swapCandidate} (${dayOfWeek === 6 ? 'суббота' : 'воскресенье'} ↔ ${dayOfWeek === 6 ? 'воскресенье' : 'суббота'})`);
                
                // Выполняем тройной обмен: employee -> выходной, swapCandidate -> на место employee, employee -> на место swapCandidate в другой день
                const candidateCurrentShift = schedule[swapCandidate][date];
                
                changes.push({
                  employee,
                  date,
                  oldShift: { ...currentShift },
                  newShift: { type: 'OFF', hours: 0, start: '', end: '', location: '' },
                  reason: 'Освобождение от работы в выходные'
                });
                
                changes.push({
                  employee: swapCandidate,
                  date,
                  oldShift: { ...candidateCurrentShift },
                  newShift: { type: 'OFF', hours: 0, start: '', end: '', location: '' },
                  reason: `Освобождение для обмена выходными с ${employee}`
                });
                
                changes.push({
                  employee,
                  date: swapDate,
                  oldShift: { ...schedule[employee][swapDate] },
                  newShift: { ...candidateCurrentShift },
                  reason: `Обмен выходными с ${swapCandidate}`
                });
                
                // Применяем изменения
                schedule[employee][date] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
                schedule[swapCandidate][date] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
                schedule[employee][swapDate] = { ...candidateCurrentShift };
                
                console.log(`🔄 Безболезненный обмен выходными выполнен`);
                return; // Выходим, замена найдена
              }
            }
          }
          
          if (replacementCandidate) {
            console.log(`✅ Найден кандидат для замены: ${replacementCandidate}`);
            
            // Меняем местами
            changes.push({
              employee,
              date,
              oldShift: { ...currentShift },
              newShift: { type: 'OFF', hours: 0, start: '', end: '', location: '' },
              reason: 'Освобождение от работы в выходные'
            });
            
            changes.push({
              employee: replacementCandidate,
              date,
              oldShift: { ...schedule[replacementCandidate][date] },
              newShift: { ...currentShift },
              reason: `Замена для ${employee}`
            });
            
            // Применяем изменения
            schedule[replacementCandidate][date] = { ...currentShift };
            schedule[employee][date] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
            
            console.log(`🔄 Обмен выполнен: ${employee} -> выходной, ${replacementCandidate} -> смена`);
          } else {
            console.log(`❌ Не найден подходящий кандидат для замены ${employee} на ${date}`);
            
            // Если замену не нашли, просто освобождаем от смены
            changes.push({
              employee,
              date,
              oldShift: { ...currentShift },
              newShift: { type: 'OFF', hours: 0, start: '', end: '', location: '' },
              reason: 'Освобождение от работы в выходные (без замены)'
            });
            
            schedule[employee][date] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
            console.log(`🔄 Освобождение без замены: ${employee} -> выходной`);
          }
        } else {
          console.log(`ℹ️ Не требуется изменений для ${employee} на ${date}: не выходной или уже выходной`);
        }
      }
    });
  });
  
  console.log(`📝 Всего изменений на данном этапе: ${changes.length}`);
  
  // 2. Минимальная балансировка часов (только если большое отклонение)
  const affectedEmployees = [...new Set(changes.map(c => c.employee))];
  console.log(`👥 Затронутые сотрудники: ${affectedEmployees.join(', ')}`);
  
  affectedEmployees.forEach(emp => {
    if (emp === supervisor) return; // Пропускаем руководителя
    
    const currentHours = Object.values(schedule[emp] || {}).reduce((sum, shift) => sum + (shift?.hours || 0), 0);
    let deviation = targetHours - currentHours;
    
    console.log(`⚖️ ${emp}: текущие часы = ${currentHours}, норма = ${targetHours}, отклонение = ${deviation}`);
    
    // Балансируем только при очень большом отклонении (больше 8 часов)
    if (Math.abs(deviation) > 8) {
      console.log(`🔧 Критическое отклонение для ${emp}: ${deviation} часов, применяем минимальную балансировку`);
      
      // Корректируем смены на будущие даты, распределяя по нескольким дням
      const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
      let remainingDeviation = deviation;
      
      // Ищем будущие даты, начиная с эталонной
      for (let day = 1; day <= daysInMonth && Math.abs(remainingDeviation) > 0.1; day++) {
        const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
        const checkDate = new Date(dateKey);
        
        // Пропускаем даты раньше эталонной
        if (checkDate < referenceDate) {
          continue;
        }
        
        const shift = schedule[emp]?.[dateKey];
        
        if (shift && shift.type !== 'OFF' && shift.type !== 'vacation') {
          let adjustment = 0;
          
          if (remainingDeviation > 0 && shift.hours < 10.5) {
            // Недобор часов - добавляем часы (до максимума 10.5 часов за смену)
            adjustment = Math.min(remainingDeviation, 10.5 - shift.hours, 3); // Максимум 3 часа за раз
          } else if (remainingDeviation < 0 && shift.hours > 6.25) {
            // Перебор часов - убираем часы (до минимума 6.25 часа за смену)
            adjustment = Math.max(remainingDeviation, 6.25 - shift.hours, -3); // Максимум 3 часа за раз
          }
          
          if (Math.abs(adjustment) > 0.1) {
            console.log(`⏰ Распределенная корректировка часов ${emp} на ${dateKey}: ${shift.hours} -> ${shift.hours + adjustment}`);
            
            // Используем универсальную функцию пересчета времени
            const newShift = recalculateShiftTime(shift, shift.hours + adjustment);
            
            changes.push({
              employee: emp,
              date: dateKey,
              oldShift: { ...shift },
              newShift: newShift,
              reason: `Балансировка часов (${remainingDeviation > 0 ? 'добавление' : 'сокращение'} ${Math.abs(adjustment)}ч)`
            });
            
            // Применяем изменения к графику
            schedule[emp][dateKey] = newShift;
            remainingDeviation -= adjustment;
          }
        }
      }
      
      if (Math.abs(remainingDeviation) > 0.1) {
        console.log(`⚠️ Не удалось полностью сбалансировать ${emp}, осталось: ${remainingDeviation} часов`);
      }
    }
  });
  
  // 3. Пересчитываем статистику
  const employeeHours = {};
  const detailedStats = {};
  
  employees.forEach(emp => {
    employeeHours[emp] = Object.values(schedule[emp] || {}).reduce((sum, shift) => sum + (shift?.hours || 0), 0);
    
    if (emp !== supervisor) {
      const empShifts = Object.values(schedule[emp] || {});
      detailedStats[emp] = {
        totalHours: employeeHours[emp],
        workDays: empShifts.filter(s => s && s.type !== 'OFF' && s.type !== 'vacation').length,
        offDays: empShifts.filter(s => s && s.type === 'OFF').length,
        dutyShifts: empShifts.filter(s => s && s.type === 'DUTY_HOME').length,
        weekendShifts: empShifts.filter(s => s && s.type === 'WEEKEND').length,
        vacationDays: empShifts.filter(s => s && s.type === 'vacation').length,
        maxConsecutiveWork: calculateMaxConsecutiveWork(schedule[emp] || {}, year, month)
      };
    }
  });
  
  console.log(`✅ Минимальные изменения применены. Всего изменений: ${changes.length}`);
  if (changes.length > 0) {
    console.log('📋 Список изменений:');
    changes.forEach((change, index) => {
      console.log(`  ${index + 1}. ${change.employee} на ${change.date}: ${change.reason}`);
    });
  }
  
  return {
    schedule,
    employeeHours,
    detailedStats,
    targetHours,
    changes: changes.length > 0 ? changes : null,
    isMinimalChange: true
  };
}

// Вспомогательная функция для расчета максимальных дней подряд
function calculateMaxConsecutiveWork(employeeSchedule, year, month) {
  const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
  let maxConsecutive = 0;
  let currentConsecutive = 0;
  
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
    const shift = employeeSchedule[dateKey];
    
    if (shift && shift.type !== 'OFF' && shift.type !== 'vacation') {
      currentConsecutive++;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }
  
  return maxConsecutive;
}

function createMonthlySchedule(year, month, employees, employeePreferences = null) {
  console.log(`🚀 Генерация графика на ${month}/${year} для ${employees.length} сотрудников`);
  const supervisor = employees[0];
  const staff = employees.slice(1);
  const targetHours = WORKING_HOURS_2025[month];
  const schedule = {};
  const preferences = employeePreferences || new EmployeePreferences();
  preferences.setupDemo(employees, year, month);
  employees.forEach(e => { schedule[e] = {}; });
  const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();

  // 1. Руководитель — фиксированный график
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    const dayOfWeek = date.day();
    const dateKey = date.format('YYYY-MM-DD');
    if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) {
      schedule[supervisor][dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
    } else if (isPreHoliday(dateKey)) {
      schedule[supervisor][dateKey] = { type: 'SUPERVISOR_PRE_HOLIDAY', hours: 7.0, start: '09:00', end: '17:00', location: 'офис' };
    } else if (dayOfWeek === 5) {
      schedule[supervisor][dateKey] = { type: 'SUPERVISOR_FRIDAY', hours: 8.0, start: '09:00', end: '17:00', location: 'офис' };
    } else {
      schedule[supervisor][dateKey] = { type: 'SUPERVISOR_DAY', hours: 8.0, start: '09:00', end: '18:00', location: 'офис' };
    }
  }

  // 2. Инициализация очередей по типу смены
  const shiftStats = {};
  staff.forEach(emp => {
    shiftStats[emp] = {
      totalHours: 0,
      MONDAY_HOME: 0,
      DUTY_HOME: 0,
      WEEKEND: 0,
      DAY: 0,
      FRIDAY: 0,
      PRE_HOLIDAY: 0,
      OFF: 0
    };
  });

  // --- СПРАВЕДЛИВОЕ РАСПРЕДЕЛЕНИЕ ДЕЖУРСТВ И ВЫХОДНЫХ ---
  // Счётчики дежурств и выходных для каждого сотрудника
  const fairnessStats = {};
  staff.forEach(emp => {
    fairnessStats[emp] = { weekend: 0, duty: 0, monday: 0 };
  });

  // Основной цикл по дням
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    const dayOfWeek = date.day();
    const dateKey = date.format('YYYY-MM-DD');
    let dailyTemplate = getDailyShiftTemplate(dayOfWeek, dateKey);
    if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) {
      dailyTemplate = ['WEEKEND'];
      while (dailyTemplate.length < staff.length) dailyTemplate.push('OFF');
    } else {
      while (dailyTemplate.length < staff.length) dailyTemplate.push('DAY');
      while (dailyTemplate.length > staff.length) dailyTemplate.pop();
    }
    const shiftsByType = {};
    dailyTemplate.forEach(shiftType => { shiftsByType[shiftType] = (shiftsByType[shiftType] || 0) + 1; });
    const assigned = new Set();
    Object.entries(shiftsByType).forEach(([shiftType, count]) => {
      for (let i = 0; i < count; i++) {
        let candidates = staff.filter(emp => {
          if (assigned.has(emp)) return false;
          const pref = preferences.getPreference(emp, dateKey);
          if (pref?.type === 'vacation') return false;
          if (!hasMinimumRest(getLastShiftEnd(schedule, emp, dateKey), `${dateKey} ${SHIFT_TYPES[shiftType].start}`)) return false;
          return true;
        });
        // --- СПРАВЕДЛИВОСТЬ: сортируем кандидатов по количеству таких смен ---
        if (shiftType === 'WEEKEND') {
          candidates.sort((a, b) => fairnessStats[a].weekend - fairnessStats[b].weekend);
        } else if (shiftType === 'DUTY_HOME') {
          candidates.sort((a, b) => fairnessStats[a].duty - fairnessStats[b].duty);
        } else if (shiftType === 'MONDAY_HOME') {
          candidates.sort((a, b) => fairnessStats[a].monday - fairnessStats[b].monday);
        }
        if (candidates.length === 0) continue;
        const chosen = candidates[0];
        assigned.add(chosen);
        if (shiftType === 'OFF') {
          schedule[chosen][dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
        } else {
          schedule[chosen][dateKey] = {
            type: shiftType,
            hours: SHIFT_TYPES[shiftType].hours,
            start: SHIFT_TYPES[shiftType].start,
            end: SHIFT_TYPES[shiftType].end,
            location: SHIFT_TYPES[shiftType].location
          };
          // --- УЧЁТ СПРАВЕДЛИВОСТИ ---
          if (shiftType === 'WEEKEND') fairnessStats[chosen].weekend++;
          if (shiftType === 'DUTY_HOME') fairnessStats[chosen].duty++;
          if (shiftType === 'MONDAY_HOME') fairnessStats[chosen].monday++;
        }
      }
    });
    staff.forEach(emp => {
      if (!assigned.has(emp)) {
        const pref = preferences.getPreference(emp, dateKey);
        if (pref?.type === 'vacation') {
          schedule[emp][dateKey] = { type: 'vacation', hours: 0, start: '', end: '', location: '', reason: pref.reason };
        } else if (schedule[emp][dateKey] == null) {
          schedule[emp][dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
        }
      }
    });
  }

  // 3.1. Усиленная жёсткая фиксация выходных/праздников: только 1 сотрудник с WEEKEND, остальные OFF (даже если стояла дневная смена)
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    const dayOfWeek = date.day();
    const dateKey = date.format('YYYY-MM-DD');
    if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) {
      // Находим всех, у кого не OFF/не vacation
      const workers = staff.filter(emp => {
        const shift = schedule[emp][dateKey];
        return shift && shift.type !== 'OFF' && shift.type !== 'vacation';
      });
      // Оставляем только одного (если несколько)
      for (let i = 0; i < workers.length; i++) {
        const emp = workers[i];
        if (i === 0) {
          // Первый — оставляем как есть (WEEKEND)
          schedule[emp][dateKey] = {
            type: 'WEEKEND',
            hours: SHIFT_TYPES.WEEKEND.hours,
            start: SHIFT_TYPES.WEEKEND.start,
            end: SHIFT_TYPES.WEEKEND.end,
            location: SHIFT_TYPES.WEEKEND.location
          };
        } else {
          // Остальные — OFF
          schedule[emp][dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
        }
      }
      // Остальным, у кого не назначено — OFF
      staff.forEach(emp => {
        if (!workers.includes(emp)) {
          const shift = schedule[emp][dateKey];
          if (!shift || shift.type !== 'OFF') {
            schedule[emp][dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
          }
        }
      });
    }
  }

  // 4. Микробалансировка: только дневные смены, чтобы выйти ровно на 151ч
  let changed = true;
  for (let iter = 0; iter < 10 && changed; iter++) {
    changed = false;
    staff.forEach(emp => {
      let dev = targetHours - Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
      if (Math.abs(dev) >= 0.25) {
        // Сначала пробуем увеличить/уменьшить длину дневных смен
        let daysToTry = [];
        for (let day = 1; day <= daysInMonth; day++) {
          const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
          const dayOfWeek = date.day();
          const dateKey = date.format('YYYY-MM-DD');
          // Меняем только будние дни!
          if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) continue;
          const shift = schedule[emp][dateKey];
          if (!shift || !['DAY', 'FRIDAY', 'PRE_HOLIDAY'].includes(shift.type)) continue;
          daysToTry.push({dateKey, type: shift.type, hours: shift.hours});
        }
        // Сортируем: пятницы и предпраздничные — сначала (их стараемся делать короче)
        daysToTry.sort((a, b) => {
          if ((a.type === 'FRIDAY' || a.type === 'PRE_HOLIDAY') && (b.type !== 'FRIDAY' && b.type !== 'PRE_HOLIDAY')) return -1;
          if ((b.type === 'FRIDAY' || b.type === 'PRE_HOLIDAY') && (a.type !== 'FRIDAY' && a.type !== 'PRE_HOLIDAY')) return 1;
          return a.hours - b.hours;
        });
        for (const {dateKey, type, hours} of daysToTry) {
          let minLen = 6.25, maxLen = 11.25;
          let newHours = hours;
          if (dev > 0.1 && hours < maxLen) {
            newHours = Math.min(maxLen, hours + Math.min(dev, 1));
          } else if (dev < -0.1 && hours > minLen) {
            newHours = Math.max(minLen, hours + Math.max(dev, -1));
          } else {
            continue;
          }
          if (Math.abs(newHours - hours) >= 0.1) {
            schedule[emp][dateKey] = recalculateShiftTime(schedule[emp][dateKey], newHours);
            changed = true;
            break;
          }
        }
        // Если всё ещё не хватает — пробуем заменить несколько коротких смен на OFF и одну длинную
        dev = targetHours - Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
        if (Math.abs(dev) >= 0.25) {
          // Если перебор — ищем самую короткую дневную смену и делаем OFF
          if (dev < -0.1) {
            let minDay = daysToTry.filter(d => d.hours > 6.25).sort((a, b) => a.hours - b.hours)[0];
            if (minDay) {
              schedule[emp][minDay.dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
              changed = true;
            }
          }
          // Если недобор — ищем OFF и делаем длинную дневную смену
          if (dev > 0.1) {
            for (let day = 1; day <= daysInMonth; day++) {
              const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
              const dayOfWeek = date.day();
              const dateKey = date.format('YYYY-MM-DD');
              if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) continue;
              const shift = schedule[emp][dateKey];
              if (shift && shift.type === 'OFF') {
                schedule[emp][dateKey] = recalculateShiftTime({type: 'DAY', start: '09:00', end: '18:00', location: 'офис', hours: 8.25}, Math.min(11.25, dev));
                changed = true;
                break;
              }
            }
          }
        }
      }
    });
  }

  // ОТЛАДОЧНЫЙ ВЫВОД: все смены на 1 июня
  const debugDate = moment(`${year}-06-01`, 'YYYY-MM-DD').format('YYYY-MM-DD');
  console.log('=== ОТЛАДКА: Смены на 1 июня ===');
  staff.forEach(emp => {
    const shift = schedule[emp][debugDate];
    console.log(`${emp}: ${shift ? shift.type + ' ' + (shift.hours || 0) : 'нет смены'}`);
  });

  // 5. Валидация и статистика
  const employeeHours = {};
  employees.forEach(emp => {
    employeeHours[emp] = Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
  });
  const detailedStats = {};
  staff.forEach(emp => {
    const empShifts = Object.values(schedule[emp]);
    detailedStats[emp] = {
      totalHours: employeeHours[emp],
      workDays: empShifts.filter(s => s && s.type !== 'OFF' && s.type !== 'vacation').length,
      offDays: empShifts.filter(s => s && s.type === 'OFF').length,
      dutyShifts: empShifts.filter(s => s && s.type === 'DUTY_HOME').length,
      weekendShifts: empShifts.filter((s, idx) => {
        const date = moment(`${year}-${month}-${idx+1}`, 'YYYY-M-D');
        const dayOfWeek = date.day();
        return (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(date.format('YYYY-MM-DD'))) && s && s.type !== 'OFF' && s.type !== 'vacation';
      }).length,
      vacationDays: empShifts.filter(s => s && s.type === 'vacation').length,
      maxConsecutiveWork: calculateMaxConsecutiveWork(schedule[emp], year, month)
    };
  });
  // Руководитель
  const empShifts = Object.values(schedule[supervisor]);
  detailedStats[supervisor] = {
    totalHours: employeeHours[supervisor],
    workDays: empShifts.filter(s => s && s.type !== 'OFF').length,
    offDays: empShifts.filter(s => s && s.type === 'OFF').length,
    dutyShifts: 0,
    weekendShifts: 0,
    vacationDays: 0,
    maxConsecutiveWork: calculateMaxConsecutiveWork(schedule[supervisor], year, month)
  };
  return { schedule, targetHours, detailedStats, preferences: preferences.preferences };
}

// Функция балансировки часов для точного соответствия норме
function balanceEmployeeHours(schedule, hoursWorked, employees, targetHoursMap, year, month) {
  const maxIterations = 30; // Увеличиваем количество итераций для точности
  let iteration = 0;
  
  while (iteration < maxIterations) {
    let needsBalance = false;
    
    // Проверяем отклонения от нормы
    const deviations = {};
    employees.forEach(emp => {
      const currentHours = Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
      const targetHours = typeof targetHoursMap === 'object' ? targetHoursMap[emp] : targetHoursMap;
      deviations[emp] = targetHours - currentHours;
      if (Math.abs(deviations[emp]) > 0.01) needsBalance = true; // Увеличиваем точность до 0.01ч
    });
    
    if (!needsBalance) break;
    
    // НОВЫЙ ПОДХОД: Умная корректировка часов с сохранением консистентности
    // Вместо изменения существующих смен, заменяем их на смены с правильными часами
    employees.forEach(emp => {
      if (Math.abs(deviations[emp]) > 0.01) {
        const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
        
        for (let day = 1; day <= daysInMonth; day++) {
          const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
          const shift = schedule[emp][dateKey];
          
          if (shift && shift.type !== 'OFF' && shift.type !== 'vacation' && Math.abs(deviations[emp]) > 0.01) {
            
            // Определяем целевые часы для коррекции
            let targetShiftHours = shift.hours;
            if (deviations[emp] > 0) {
              // Нужно добавить часы - ищем подходящий тип смены с большими часами
              targetShiftHours = findOptimalHours(shift, deviations[emp], 'increase');
            } else {
              // Нужно убрать часы - ищем подходящий тип смены с меньшими часами  
              targetShiftHours = findOptimalHours(shift, deviations[emp], 'decrease');
            }
            
            // Если нашли подходящий вариант, заменяем смену
            if (targetShiftHours !== shift.hours) {
              const newShift = findShiftTypeByHours(targetShiftHours, shift.location);
              if (newShift) {
                console.log(`🔄 Балансировка ${emp} на ${dateKey}: ${shift.type} (${shift.hours}ч) -> ${newShift.type} (${newShift.hours}ч)`);
                
                schedule[emp][dateKey] = {
                  type: newShift.type,
                  hours: newShift.hours,
                  start: newShift.start,
                  end: newShift.end,
                  location: newShift.location
                };
                
                deviations[emp] -= (newShift.hours - shift.hours);
              }
            }
          }
          
          if (Math.abs(deviations[emp]) <= 0.01) break;
        }
      }
    });
    
    // Если корректировка типов смен не помогла, пробуем перераспределить смены
    const deficit = employees.filter(emp => deviations[emp] > 0.25);
    const surplus = employees.filter(emp => deviations[emp] < -0.25);
    
    for (const deficitEmp of deficit) {
      for (const surplusEmp of surplus) {
        if (Math.abs(deviations[deficitEmp]) < 0.25 || Math.abs(deviations[surplusEmp]) < 0.25) continue;
        
        const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
        for (let day = 1; day <= daysInMonth; day++) {
          const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
          
          const deficitShift = schedule[deficitEmp][dateKey];
          const surplusShift = schedule[surplusEmp][dateKey];
          
          // Обмен смен OFF <-> рабочая смена
          if (deficitShift.type === 'OFF' && surplusShift.type !== 'OFF' && 
              surplusShift.hours <= Math.abs(deviations[deficitEmp]) + 0.25) {
            
            if (hasMinimumRest(getLastShiftEnd(schedule, deficitEmp, dateKey), `${dateKey} ${surplusShift.start}`) &&
                hasMinimumRest(`${dateKey} ${surplusShift.end}`, getNextShiftStart(schedule, deficitEmp, dateKey))) {
              
              // Обмениваемся сменами
              schedule[deficitEmp][dateKey] = { ...surplusShift };
              schedule[surplusEmp][dateKey] = { type: 'OFF', hours: 0, start: '', end: '', location: '' };
              
              deviations[deficitEmp] -= surplusShift.hours;
              deviations[surplusEmp] += surplusShift.hours;
              
              break;
            }
          }
        }
      }
    }
    
    // ФИНАЛЬНАЯ ТОЧНАЯ КОРРЕКТИРОВКА: минимальная коррекция часов для достижения точно 151ч
    if (iteration > 15) { // Применяем только в конце процесса
      employees.forEach(emp => {
        if (Math.abs(deviations[emp]) > 0.1 && Math.abs(deviations[emp]) < 1.0) {
          const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
          
          // Ищем лучшую смену для минимальной корректировки
          for (let day = 1; day <= daysInMonth; day++) {
            const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
            const shift = schedule[emp][dateKey];
            
            if (shift && shift.type !== 'OFF' && shift.type !== 'vacation') {
              // Применяем точную корректировку в пределах 0.5ч
              const adjustment = Math.max(-0.5, Math.min(0.5, deviations[emp]));
              const newHours = Math.round((shift.hours + adjustment) * 4) / 4; // Округляем до 0.25ч
              
              // Проверяем что корректировка разумна
              if (newHours >= 6.0 && newHours <= 11.0 && Math.abs(adjustment) >= 0.01) {
                console.log(`🎯 Финальная корректировка ${emp} на ${dateKey}: ${shift.hours}ч -> ${newHours}ч (${adjustment > 0 ? '+' : ''}${adjustment}ч)`);
                
                // Создаем новую смену с точными часами
                const newShift = recalculateShiftTime(shift, newHours);
                schedule[emp][dateKey] = newShift;
                
                deviations[emp] -= adjustment;
                break;
              }
            }
          }
        }
      });
    }
    
    iteration++;
  }
  
  // Обновляем счетчики часов
  employees.forEach(emp => {
    hoursWorked[emp] = Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
  });
  
  // Выводим итоговую статистику балансировки
  console.log('📊 Итоги балансировки:');
  employees.forEach(emp => {
    const targetHours = typeof targetHoursMap === 'object' ? targetHoursMap[emp] : targetHoursMap;
    const deviation = targetHours - hoursWorked[emp];
    console.log(`  ${emp}: ${hoursWorked[emp]}ч (цель: ${targetHours}ч, отклонение: ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)}ч)`);
  });
}

// Новая функция для поиска оптимальных часов
function findOptimalHours(currentShift, deviation, direction) {
  const currentHours = currentShift.hours;
  const location = currentShift.location;
  
  // Доступные варианты часов для каждой локации
  // ИСПРАВЛЕНО: убираем часы руководителя (8.0) из офисных смен
  const availableHours = {
    'офис': [7.25, 8.25], // FRIDAY, DAY (без SUPERVISOR - 8.0ч)
    'дом': [9.25, 10.25]  // DUTY_HOME, MONDAY_HOME
  };
  
  const options = availableHours[location] || [];
  
  if (direction === 'increase') {
    // Ищем ближайшее большее значение
    const target = options.find(h => h > currentHours && h <= currentHours + Math.abs(deviation) + 0.25);
    return target || currentHours;
  } else {
    // Ищем ближайшее меньшее значение
    const target = options.reverse().find(h => h < currentHours && h >= currentHours - Math.abs(deviation) - 0.25);
    return target || currentHours;
  }
}

// Новая функция для поиска типа смены по часам
function findShiftTypeByHours(targetHours, location) {
  // Ищем тип смены с нужными часами и локацией
  // ИСПРАВЛЕНО: исключаем типы смен руководителя и MONDAY_DUTY_HOME
  const excludedTypes = ['SUPERVISOR_DAY', 'SUPERVISOR_FRIDAY', 'SUPERVISOR_PRE_HOLIDAY'];
  
  for (const [type, config] of Object.entries(SHIFT_TYPES)) {
    // Пропускаем исключенные типы смен
    if (excludedTypes.includes(type)) continue;
    
    if (config.hours === targetHours && config.location === location) {
      return {
        type: type,
        hours: config.hours,
        start: config.start,
        end: config.end,
        location: config.location
      };
    }
  }
  return null;
}

// Получение времени начала следующей смены сотрудника
function getNextShiftStart(schedule, employee, currentDate) {
  const current = moment(currentDate);
  const tomorrow = current.add(1, 'day').format('YYYY-MM-DD');
  
  if (schedule[employee][tomorrow]) {
    const shift = schedule[employee][tomorrow];
    if (shift.start) {
      return `${tomorrow} ${shift.start}`;
    }
  }
  return null;
}

// Получение времени окончания последней смены сотрудника
function getLastShiftEnd(schedule, employee, currentDate) {
  const current = moment(currentDate);
  const yesterday = current.subtract(1, 'day').format('YYYY-MM-DD');
  
  if (schedule[employee][yesterday]) {
    const shift = schedule[employee][yesterday];
    if (shift.end === '02:00' || shift.end === '07:00') {
      // Ночная смена заканчивается на следующий день
      return `${currentDate} ${shift.end}`;
    } else {
      return `${yesterday} ${shift.end}`;
    }
  }
  return null;
}

// Экспорт в Excel
async function exportToExcel(schedule, employeeHours, targetHours, year, month, detailedStats) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('График работы');
  
  // Объявляем borderStyle в начале функции
  const borderStyle = { style: 'thin', color: { argb: 'FF000000' } };
  
  const employees = Object.keys(schedule);
  const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
  
  // Создаем заголовки (транспонированный формат)
  const dateHeaders = ['Сотрудник'];
  const dayHeaders = ['День недели'];
  
  // Заголовки дат и дней недели
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    dateHeaders.push(date.format('DD.MM'));
    dayHeaders.push(['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][date.day()]);
  }
  
  // Добавляем столбцы статистики + вычисляемый столбец
  dateHeaders.push('Сумма часов (AH)', 'Итого часов', 'Рабочих дней', 'Выходных', 'Дежурств', 'Макс. подряд', 'Работа в выходные');
  dayHeaders.push('', '', '', '', '', '', '');
  
  // Добавляем заголовки дат
  worksheet.addRow(dateHeaders);
  worksheet.addRow(dayHeaders);
  
  // Вычисляем статистику работы в выходные
  const weekendWorkStats = {};
  employees.forEach(emp => {
    let weekendWorkDays = 0;
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
      const dateKey = date.format('YYYY-MM-DD');
      const dayOfWeek = date.day();
      const shift = schedule[emp][dateKey];
      
      // Считаем работу в выходные (суббота/воскресенье) и праздники
      if ((dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) && 
          shift && shift.type !== 'OFF') {
        weekendWorkDays++;
      }
    }
    
    weekendWorkStats[emp] = weekendWorkDays;
  });
  
  // Добавляем данные по сотрудникам
  employees.forEach((emp, index) => {
    const row = [emp + (index === 0 ? ' (Руководитель)' : '')];
    
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      const shift = schedule[emp][dateKey];
      
      if (shift) {
        if (shift.type === 'OFF') {
          row.push('—');
        } else if (shift.type === 'vacation') {
          row.push('ОТПУСК');
        } else {
          const locationText = shift.location === 'дом' ? ' (дом)' : '';
          // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: используем ТОЛЬКО расчетные часы shift.hours
          row.push(`${shift.start}-${shift.end}${locationText} (${shift.hours}ч)`);
        }
      } else {
        row.push('');
      }
    }
    
    // Добавляем статистику (убираем формулы)
    const totalHours = Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
    
    if (index === 0) {
      // Руководитель
      const workDays = Object.values(schedule[emp]).filter(shift => shift.type !== 'OFF').length;
      const offDays = Object.values(schedule[emp]).filter(shift => shift.type === 'OFF').length;
      row.push(totalHours + 'ч', totalHours + 'ч', workDays, offDays, '-', '-', weekendWorkStats[emp] || 0);
    } else {
      // Сотрудники СУРВ
      const stats = detailedStats[emp] || {};
      row.push(
        totalHours + 'ч',
        totalHours + 'ч',
        stats.workDays || 0,
        stats.offDays || 0,
        stats.dutyShifts || 0,
        stats.maxConsecutiveWork || 0,
        weekendWorkStats[emp] || 0
      );
    }
    
    worksheet.addRow(row);
  });
  
  // Цветовая кодировка ячеек по типам смен
  employees.forEach((emp, empRowIndex) => {
    const rowIndex = empRowIndex + 3; // +3 потому что 2 строки заголовков + 1-based indexing
    
    for (let day = 1; day <= daysInMonth; day++) {
      const colIndex = day + 1; // +1 потому что первый столбец - имена
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      const shift = schedule[emp][dateKey];
      
      if (shift && shift.type !== 'OFF') {
        const cell = worksheet.getCell(rowIndex, colIndex);
        let bgColor = SHIFT_TYPES[shift.type]?.color || 'FFE5E7EB';
        if (shift.type === 'vacation') {
          bgColor = 'FFEF4444'; // Красный для отпуска
        }
        // --- ВЫДЕЛЕНИЕ ПРАЗДНИКОВ КРАСНЫМ ---
        if (isHoliday(dateKey)) {
          bgColor = 'FFEF4444'; // Красный для праздников
        }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgColor }
        };
        const darkColors = ['FF374151', 'FF3B82F6', 'FF1E40AF', 'FFEF4444', 'FF059669', 'FF8B5CF6'];
        if (darkColors.includes(bgColor)) {
          cell.font = { color: { argb: 'FFFFFFFF' } };
        }
      }
    }
  });
  
  // Добавляем пустую строку и итоги
  worksheet.addRow([]);
  const summaryRow = ['Общие итоги:'];
  for (let day = 1; day <= daysInMonth; day++) {
    summaryRow.push(''); // Пустые ячейки для дат
  }
  summaryRow.push('', '', '', '', '', '', ''); // Пустые для статистики
  worksheet.addRow(summaryRow);
  
  // Итоги по сотрудникам (БЕЗ границ согласно требованию)
  employees.forEach(emp => {
    const totalHours = Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
    const summaryEmpRow = [emp, totalHours + 'ч'];
    
    // Заполняем остальные ячейки пустыми до конца таблицы
    for (let day = 2; day <= daysInMonth + 7; day++) { // +7 потому что добавили столбец AH
      summaryEmpRow.push('');
    }
    
    const summaryRow = worksheet.addRow(summaryEmpRow);
    
    // Форматирование итоговых строк (БЕЗ границ)
    summaryRow.getCell(1).font = { bold: true };
    summaryRow.getCell(2).font = { bold: true };
    summaryRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // УБИРАЕМ границы для итоговых строк согласно требованию
    // Границы НЕ нужны начиная с раздела "Общие итоги"
  });
  
  // Добавляем легенду на отдельный лист
  const legendSheet = workbook.addWorksheet('Легенда');
  
  legendSheet.addRow(['ЛЕГЕНДА ТИПОВ СМЕН']);
  legendSheet.addRow(['']);
  
  Object.entries(SHIFT_TYPES).forEach(([key, shiftType]) => {
    if (key !== 'OFF') {
      const row = legendSheet.addRow([
        shiftType.name,
        `${shiftType.start || ''} - ${shiftType.end || ''}`,
        `${shiftType.hours}ч`,
        shiftType.location || ''
      ]);
      
      // Применяем цвет
      row.getCell(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: shiftType.color }
      };
      
      // Белый текст для темных фонов
      const darkColors = ['FF374151', 'FF3B82F6', 'FF1E40AF', 'FFEF4444', 'FF059669', 'FF8B5CF6'];
      if (darkColors.includes(shiftType.color)) {
        row.getCell(1).font = { color: { argb: 'FFFFFFFF' } };
      }
    }
  });
  
  // Добавляем отпуск в легенду
  const vacationRow = legendSheet.addRow(['Отпуск', '-', '0ч', 'дом']);
  vacationRow.getCell(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEF4444' }
  };
  vacationRow.getCell(1).font = { color: { argb: 'FFFFFFFF' } };
  
  // Стилизация основного листа
  worksheet.getRow(1).font = { bold: true, size: 12 };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2563EB' }
  };
  worksheet.getRow(1).font.color = { argb: 'FFFFFFFF' };
  
  worksheet.getRow(2).font = { bold: true };
  worksheet.getRow(2).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE5E7EB' }
  };
  
  // Столбец с фамилиями
  worksheet.getColumn(1).width = 25;
  worksheet.getColumn(1).font = { bold: true };
  
  // Остальные столбцы
  for (let col = 2; col <= daysInMonth + 7; col++) { // +7 для добавленного столбца AH
    if (col <= daysInMonth + 1) {
      worksheet.getColumn(col).width = 15;
    } else {
      worksheet.getColumn(col).width = 12; // Статистика
    }
    worksheet.getColumn(col).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  }
  
  // Форматирование всех столбцов статистики одинаково (включая новый столбец AH)
  for (let statCol = daysInMonth + 2; statCol <= daysInMonth + 8; statCol++) { // +8 для нового столбца AH
    worksheet.getColumn(statCol).width = 12;
    worksheet.getColumn(statCol).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    worksheet.getColumn(statCol).font = { bold: false };
  }
  
  // Выделяем выходные дни и праздники
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    const dateStr = date.format('YYYY-MM-DD');
    const col = day + 1;
    
    if (date.day() === 0 || date.day() === 6 || isHoliday(dateStr)) {
      for (let row = 1; row <= employees.length + 2; row++) {
        const cell = worksheet.getCell(row, col);
        if (!cell.fill?.fgColor) { // Не перезаписываем цвет смен
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFECACA' }
          };
        }
      }
    } else if (isPreHoliday(dateStr)) {
      for (let row = 1; row <= employees.length + 2; row++) {
        const cell = worksheet.getCell(row, col);
        if (!cell.fill?.fgColor) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFEF3C7' }
          };
        }
      }
    }
  }
  
  // Стилизация легенды
  legendSheet.getRow(1).font = { bold: true, size: 14 };
  legendSheet.getColumn(1).width = 30;
  legendSheet.getColumn(2).width = 15;
  legendSheet.getColumn(3).width = 10;
  legendSheet.getColumn(4).width = 15;
  
  // Границы
  const totalRowsBase = employees.length + 2;
  const totalColsBase = daysInMonth + 7; // +7 потому что добавили столбец AH
  
  // Границы ТОЛЬКО для основной таблицы (без лишних областей)
  // Основная таблица: заголовки + сотрудники + итоговые строки
  const mainTableRows = employees.length + 2; // заголовки + сотрудники
  const summaryStartRow = mainTableRows + 2; // +1 пустая строка, +1 "Общие итоги"
  const totalMainRows = summaryStartRow + employees.length; // + строки итогов сотрудников
  
  // Границы для основной таблицы
  for (let row = 1; row <= mainTableRows; row++) {
    for (let col = 1; col <= totalColsBase; col++) {
      const cell = worksheet.getCell(row, col);
      cell.border = {
        top: borderStyle,
        left: borderStyle,
        bottom: borderStyle,
        right: borderStyle
      };
    }
  }
  
  // Границы для итоговых строк (уже добавлены в цикле выше)
  
  // Добавляем новый лист "Фактические часы" - полная структура для корректировки
  const factualSheet = workbook.addWorksheet('Фактические часы');
  
  // Создаем такие же заголовки как в основном листе
  const factualDateHeaders = ['Сотрудник'];
  const factualDayHeaders = ['День недели'];
  
  // Заголовки дат и дней недели (аналогично основному листу)
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    factualDateHeaders.push(date.format('DD.MM'));
    factualDayHeaders.push(['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][date.day()]);
  }
  
  // Добавляем заголовки (без столбцов статистики для простоты)
  factualSheet.addRow(factualDateHeaders);
  factualSheet.addRow(factualDayHeaders);
  
  // Добавляем данные по сотрудникам с цветовой маркировкой и расчетными значениями
  employees.forEach((emp, index) => {
    const row = [emp + (index === 0 ? ' (Руководитель)' : '')];
    
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      const shift = schedule[emp][dateKey];
      
      if (shift) {
        if (shift.type === 'OFF') {
          row.push('—');
        } else if (shift.type === 'vacation') {
          row.push('ОТПУСК');
        } else {
          // Только расчетное значение часов для быстрой корректировки
          row.push(shift.hours);
        }
      } else {
        row.push('');
      }
    }
    
    factualSheet.addRow(row);
  });
  
  // Цветовая кодировка как в основном листе
  employees.forEach((emp, empRowIndex) => {
    const rowIndex = empRowIndex + 3; // +3 потому что 2 строки заголовков + 1-based indexing
    
    for (let day = 1; day <= daysInMonth; day++) {
      const colIndex = day + 1;
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      const shift = schedule[emp][dateKey];
      
      if (shift && shift.type !== 'OFF') {
        const cell = factualSheet.getCell(rowIndex, colIndex);
        
        let bgColor = SHIFT_TYPES[shift.type]?.color || 'FFE5E7EB';
        if (shift.type === 'vacation') {
          bgColor = 'FFEF4444';
        }
        
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgColor }
        };
        
        const darkColors = ['FF374151', 'FF3B82F6', 'FF1E40AF', 'FFEF4444', 'FF059669', 'FF8B5CF6'];
        if (darkColors.includes(bgColor)) {
          cell.font = { color: { argb: 'FFFFFFFF' } };
        }
      }
    }
  });
  
  // Стилизация заголовков как в основном листе
  factualSheet.getRow(1).font = { bold: true, size: 12 };
  factualSheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2563EB' }
  };
  factualSheet.getRow(1).font.color = { argb: 'FFFFFFFF' };
  
  factualSheet.getRow(2).font = { bold: true };
  factualSheet.getRow(2).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE5E7EB' }
  };
  
  // Форматирование столбцов
  factualSheet.getColumn(1).width = 25;
  factualSheet.getColumn(1).font = { bold: true };
  
  for (let col = 2; col <= daysInMonth + 1; col++) {
    factualSheet.getColumn(col).width = 12;
    factualSheet.getColumn(col).alignment = { horizontal: 'center', vertical: 'middle' };
  }
  
  // Выделяем выходные дни и праздники как в основном листе
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    const dateStr = date.format('YYYY-MM-DD');
    const col = day + 1;
    
    if (date.day() === 0 || date.day() === 6 || isHoliday(dateStr)) {
      for (let row = 1; row <= employees.length + 2; row++) {
        const cell = factualSheet.getCell(row, col);
        if (!cell.fill?.fgColor) { // Не перезаписываем цвет смен
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFECACA' }
          };
        }
      }
    } else if (isPreHoliday(dateStr)) {
      for (let row = 1; row <= employees.length + 2; row++) {
        const cell = factualSheet.getCell(row, col);
        if (!cell.fill?.fgColor) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFEF3C7' }
          };
        }
      }
    }
  }
  
  const filename = `график_${year}_${String(month).padStart(2, '0')}.xlsx`;
  await workbook.xlsx.writeFile(filename);
  return filename;
}

// === ФУНКЦИИ ДЛЯ РАБОТЫ С БАЗОЙ ДАННЫХ ===

// Функция для сохранения графика в БД с поддержкой версионности
async function saveScheduleToDatabase(scheduleData, employeeNames, previousSchedule = null) {
  try {
    // Проверяем/создаем организацию
    let organization = await prisma.organization.findFirst({
      where: { name: 'Отдел информационных технологий' }
    });

    if (!organization) {
      organization = await prisma.organization.create({
        data: {
          name: 'Отдел информационных технологий',
          description: 'Основной IT отдел с системой СУРВ'
        }
      });
    }

    // Создаем/обновляем сотрудников
    const employeeIds = {};
    for (let i = 0; i < employeeNames.length; i++) {
      const name = employeeNames[i];
      const position = i === 0 ? 'SUPERVISOR' : 'STAFF';
      
      let employee = await prisma.employee.findFirst({
        where: { 
          fullName: name,
          organizationId: organization.id
        }
      });

      if (!employee) {
        employee = await prisma.employee.create({
          data: {
            organizationId: organization.id,
            fullName: name,
            position: position,
            isActive: true
          }
        });
      } else {
        // Обновляем позицию если нужно
        if (employee.position !== position) {
          await prisma.employee.update({
            where: { id: employee.id },
            data: { position: position }
          });
        }
      }
      
      employeeIds[name] = employee.id;
    }

    const { year, month, targetHours } = scheduleData;

    // Проверяем есть ли уже график за этот период
    const existingSchedule = await prisma.schedule.findFirst({
      where: {
        organizationId: organization.id,
        year: parseInt(year),
        month: parseInt(month)
      },
      orderBy: { version: 'desc' }
    });

    let version = 1;
    let parentId = null;
    let changes = null;

    if (existingSchedule) {
      version = existingSchedule.version + 1;
      parentId = existingSchedule.id;
      
      // Используем изменения переданные в scheduleData, если есть
      if (scheduleData.changes) {
        changes = JSON.stringify(scheduleData.changes);
      }
    }

    // Создаем новую версию графика
    const schedule = await prisma.schedule.create({
      data: {
        organizationId: organization.id,
        name: `График СУРВ ${month}/${year} v${version}`,
        year: parseInt(year),
        month: parseInt(month),
        version: version,
        parentId: parentId,
        targetHours: parseInt(targetHours),
        status: 'PUBLISHED',
        changes: changes
      }
    });

    // Сохраняем смены
    const shifts = [];
    Object.entries(scheduleData.schedule).forEach(([employeeName, employeeShifts]) => {
      const employeeId = employeeIds[employeeName];
      
      Object.entries(employeeShifts).forEach(([date, shift]) => {
        if (shift.type !== 'OFF') {
          // Сохраняем время как строку напрямую, без конвертации через Date
          let startTime = shift.start || '';
          let endTime = shift.end || '';
          
          shifts.push({
            scheduleId: schedule.id,
            employeeId: employeeId,
            workDate: new Date(date),
            shiftType: shift.type === 'vacation' ? 'VACATION' : shift.type,
            startTime: startTime ? new Date(`1970-01-01T${startTime}:00`) : null,
            endTime: endTime ? new Date(`1970-01-01T${endTime}:00`) : null,
            hours: parseFloat(shift.hours || 0),
            location: shift.location === 'дом' ? 'HOME' : 'OFFICE'
          });
        }
      });
    });

    if (shifts.length > 0) {
      await prisma.scheduleShift.createMany({
        data: shifts
      });
    }

    // Сохраняем статистику
    const statistics = [];
    
    // Сохраняем статистику для ВСЕХ сотрудников (включая руководителя)
    employeeNames.forEach(employeeName => {
      const empSchedule = scheduleData.schedule[employeeName] || {};
      const totalHours = Object.values(empSchedule).reduce((sum, shift) => sum + (shift.hours || 0), 0);
      
      // Статистика сотрудников СУРВ из detailedStats
      if (scheduleData.detailedStats && scheduleData.detailedStats[employeeName]) {
        const stats = scheduleData.detailedStats[employeeName];
        statistics.push({
          scheduleId: schedule.id,
          employeeId: employeeIds[employeeName],
          totalHours: parseFloat(totalHours),
          workDays: parseInt(stats.workDays || 0),
          offDays: parseInt(stats.offDays || 0),
          dutyShifts: parseInt(stats.dutyShifts || 0),
          weekendShifts: parseInt(stats.weekendShifts || 0),
          vacationDays: parseInt(stats.vacationDays || 0),
          maxConsecutiveWork: parseInt(stats.maxConsecutiveWork || 0)
        });
      } else {
        // Статистика руководителя (рассчитываем на лету)
        const workDays = Object.values(empSchedule).filter(shift => shift.type !== 'OFF').length;
        const offDays = Object.values(empSchedule).filter(shift => shift.type === 'OFF').length;
        
        statistics.push({
          scheduleId: schedule.id,
          employeeId: employeeIds[employeeName],
          totalHours: parseFloat(totalHours),
          workDays: workDays,
          offDays: offDays,
          dutyShifts: 0, // Руководитель не дежурит
          weekendShifts: 0, // Руководитель не работает в выходные
          vacationDays: 0, // Пока не учитываем отпуск руководителя
          maxConsecutiveWork: 0 // Не критично для руководителя
        });
      }
    });

    if (statistics.length > 0) {
      await prisma.scheduleStatistic.createMany({
        data: statistics
      });
    }

    return { 
      success: true, 
      scheduleId: schedule.id, 
      version: version,
      changes: scheduleData.changes || null
    };
  } catch (error) {
    console.error('Ошибка сохранения в БД:', error);
    return { success: false, error: error.message };
  }
}

// Функция для вычисления изменений между версиями графиков
function calculateScheduleChanges(oldSchedule, newSchedule) {
  const changes = [];
  
  Object.keys(newSchedule).forEach(employee => {
    // Исключаем руководителя из изменений, так как у неё всегда стандартный график
    if (employee === 'Теканова Н.И.' || employee.includes('Теканова')) {
      return;
    }
    
    Object.keys(newSchedule[employee]).forEach(date => {
      const oldShift = oldSchedule[employee]?.[date];
      const newShift = newSchedule[employee][date];
      
      // Проверяем реальные изменения
      if (!oldShift || 
          oldShift.type !== newShift.type || 
          oldShift.start !== newShift.start || 
          oldShift.end !== newShift.end ||
          oldShift.location !== newShift.location) {
        
        changes.push({
          employee: employee,
          date: date,
          oldShift: oldShift || { type: 'OFF', start: '', end: '', location: '' },
          newShift: newShift,
          changeType: !oldShift ? 'added' : 'modified'
        });
      }
    });
  });
  
  return changes;
}

// Функция для загрузки графика из БД
async function loadScheduleFromDatabase(year, month, organizationId = null, version = null) {
  try {
    let whereClause = { year: parseInt(year), month: parseInt(month) };
    if (organizationId) {
      whereClause.organizationId = organizationId;
    }
    if (version) {
      whereClause.version = version;
    }

    const schedule = await prisma.schedule.findFirst({
      where: whereClause,
      orderBy: version ? undefined : { version: 'desc' }, // Если версия не указана, берем последнюю
      include: {
        organization: true,
        parent: {
          select: { id: true, version: true, name: true }
        },
        shifts: {
          include: {
            employee: true
          }
        },
        statistics: {
          include: {
            employee: true
          }
        }
      }
    });

    if (!schedule) {
      return { success: false, error: 'График не найден' };
    }

    // Преобразуем в формат фронтенда
    const scheduleData = {};
    const employeeHours = {};
    const detailedStats = {};

    // Группируем по сотрудникам
    const employeeMap = new Map();
    schedule.shifts.forEach(shift => {
      const emp = shift.employee;
      if (!employeeMap.has(emp.id)) {
        employeeMap.set(emp.id, {
          name: emp.fullName,
          position: emp.position,
          shifts: [],
          stats: null
        });
      }
      employeeMap.get(emp.id).shifts.push(shift);
    });

    // Добавляем статистику
    schedule.statistics.forEach(stat => {
      const empData = employeeMap.get(stat.employeeId);
      if (empData) {
        empData.stats = stat;
      }
    });

    // Разделяем руководителей и сотрудников, сохраняя правильный порядок
    const supervisors = [];
    const staff = [];
    
    employeeMap.forEach((empData, empId) => {
      scheduleData[empData.name] = {};
      employeeHours[empData.name] = parseFloat(empData.stats?.totalHours || 0);
      
      if (empData.stats) {
        detailedStats[empData.name] = {
          workDays: empData.stats.workDays,
          offDays: empData.stats.offDays,
          dutyShifts: empData.stats.dutyShifts,
          weekendShifts: empData.stats.weekendShifts,
          vacationDays: empData.stats.vacationDays,
          maxConsecutiveWork: empData.stats.maxConsecutiveWork
        };
      }

      // Классифицируем по должности
      if (empData.position === 'SUPERVISOR') {
        supervisors.push(empData.name);
      } else {
        staff.push(empData.name);
      }

      // Формируем смены по датам
      empData.shifts.forEach(shift => {
        const dateStr = shift.workDate.toISOString().split('T')[0];
        const shiftType = SHIFT_TYPES[shift.shiftType] || SHIFT_TYPES.DAY;
        
        // ВСЕГДА используем эталонные значения времени из конфигурации
        const startTime = shiftType.start;
        const endTime = shiftType.end;
        
        scheduleData[empData.name][dateStr] = {
          type: shift.shiftType,
          start: startTime,
          end: endTime,
          hours: parseFloat(shift.hours),
          location: shift.location === 'HOME' ? 'дом' : 'офис'
        };
        // УБИРАЕМ накопление часов - используем только данные из БД статистики
      });
    });

    // Правильный порядок: сначала руководители, потом сотрудники
    const employees = [...supervisors, ...staff.sort()];

    return {
      success: true,
      schedule: scheduleData,
      employeeHours,
      targetHours: schedule.targetHours,
      employees,
      detailedStats,
      year: schedule.year,
      month: schedule.month,
      version: schedule.version,
      parentVersion: schedule.parent?.version,
      changes: schedule.changes ? JSON.parse(schedule.changes) : null
    };
  } catch (error) {
    console.error('Ошибка загрузки из БД:', error);
    return { success: false, error: error.message };
  }
}

// === ДОПОЛНИТЕЛЬНЫЕ API МАРШРУТЫ ===

// Загрузка сохраненного графика
app.get('/api/schedule/:year/:month', requireAuth, async (req, res) => {
  try {
    const { year, month } = req.params;
    const result = await loadScheduleFromDatabase(year, month);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Список всех сохраненных графиков
app.get('/api/schedules', requireAuth, async (req, res) => {
  try {
    const schedules = await prisma.schedule.findMany({
      include: {
        organization: {
          select: { name: true }
        }
      },
      orderBy: [
        { year: 'desc' },
        { month: 'desc' }
      ]
    });

    const formattedSchedules = schedules.map(schedule => ({
      id: schedule.id,
      name: schedule.name,
      year: schedule.year,
      month: schedule.month,
      targetHours: schedule.targetHours,
      status: schedule.status,
      organization: schedule.organization.name,
      createdAt: schedule.createdAt
    }));

    res.json({ success: true, schedules: formattedSchedules });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API маршрут для загрузки списка сотрудников
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const employeeData = await loadEmployeesFromDatabase();
    const employees = employeeData.map(emp => emp.name || emp); // Только имена для совместимости
    res.json({ success: true, employees, employeeDetails: employeeData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Обновленный маршрут генерации с сохранением в БД
app.post('/api/generate-schedule', requireAuth, async (req, res) => {
  try {
    const { year, month, customNames, preferences, saveToDb = true, regenerate = false } = req.body;
    
    // Сначала проверяем есть ли уже график
    let existingSchedule = null;
    if (!regenerate) {
      const loadResult = await loadScheduleFromDatabase(year, month);
      if (loadResult.success) {
        // Возвращаем существующий график
        return res.json({
          ...loadResult,
          success: true,
          filename: null, // Excel файл не генерируем для существующего графика
          fromDatabase: true
        });
      }
    } else {
      // При регенерации загружаем текущую версию для сравнения
      const loadResult = await loadScheduleFromDatabase(year, month);
      if (loadResult.success) {
        existingSchedule = loadResult;
      }
    }
    
    let employees;
    if (customNames && customNames.length >= 8) {
      employees = customNames;
    } else {
      // Сначала пробуем загрузить из БД
      const employeeData = await loadEmployeesFromDatabase();
      employees = employeeData.map(emp => emp.name || emp); // Поддержка обеих форматов
      
      // Если в БД недостаточно сотрудников, используем запасной вариант
      if (employees.length < 8) {
        employees = generateRandomNames(8);
      }
    }

    let responseData;
    
    // Определяем стратегию: минимальные изменения или полная генерация
    if (existingSchedule && preferences && Object.keys(preferences).length > 0) {
      console.log('🔄 Применяем минимальные изменения к существующему графику...');
      
      // Применяем минимальные изменения
      const result = applyMinimalChangesToSchedule(existingSchedule, preferences, employees, year, month);
      
      responseData = {
        success: true,
        schedule: result.schedule,
        employeeHours: result.employeeHours,
        targetHours: result.targetHours,
        employees,
        detailedStats: result.detailedStats,
        preferences: {},
        filename: null, // Генерируем Excel позже
        year,
        month,
        fromDatabase: false,
        isMinimalChange: true,
        minimalChanges: result.changes // Всегда передаем, даже если null
      };
      
    } else {
      console.log('🔄 Выполняем полную генерацию графика...');
      
      // Создаем объект пожеланий если передан
      let employeePreferences = null;
      if (preferences) {
        employeePreferences = new EmployeePreferences();
        
        // Загружаем пожелания с фронтенда
        Object.entries(preferences).forEach(([employee, empPrefs]) => {
          Object.entries(empPrefs).forEach(([date, pref]) => {
            employeePreferences.setPreference(employee, date, pref.type, pref.reason);
          });
        });
      }
      
      const { schedule, targetHours, detailedStats, preferences: usedPreferences } = createMonthlySchedule(year, month, employees, employeePreferences);
      
      // Пересчитываем итоговые часы для каждого сотрудника
      const employeeHours = {};
      employees.forEach(emp => {
        employeeHours[emp] = Object.values(schedule[emp]).reduce((sum, shift) => sum + (shift.hours || 0), 0);
      });
      
      responseData = {
        success: true,
        schedule,
        employeeHours,
        targetHours,
        employees,
        detailedStats,
        preferences: usedPreferences,
        filename: null, // Генерируем Excel позже
        year,
        month,
        fromDatabase: false,
        isMinimalChange: false
      };
    }
    
    // Экспорт в Excel
    const filename = await exportToExcel(responseData.schedule, responseData.employeeHours, responseData.targetHours, year, month, responseData.detailedStats);
    responseData.filename = filename;

    // Сохраняем в базу данных если запрошено
    if (saveToDb) {
      const saveResult = await saveScheduleToDatabase(responseData, employees, existingSchedule);
      if (saveResult.success) {
        responseData.savedToDb = true;
        responseData.scheduleId = saveResult.scheduleId;
        responseData.version = saveResult.version;
        
        // Для минимальных изменений используем реальные изменения из функции applyMinimalChangesToSchedule
        if (responseData.isMinimalChange && responseData.minimalChanges) {
          console.log('📝 Используем минимальные изменения для отображения');
          responseData.changesDescription = formatMinimalChangesDescription(responseData.minimalChanges);
          responseData.changes = responseData.minimalChanges; // Сохраняем в БД тоже только реальные изменения
        } else if (regenerate && saveResult.changes && saveResult.changes.length > 0) {
          // Для полной регенерации используем изменения из сравнения графиков
          responseData.changesDescription = formatChangesDescription(saveResult.changes);
          responseData.changes = saveResult.changes;
        }
        
        console.log(`✅ График сохранен в БД с ID: ${saveResult.scheduleId}, версия: ${saveResult.version}`);
      } else {
        console.warn(`⚠️ Не удалось сохранить в БД: ${saveResult.error}`);
        responseData.savedToDb = false;
        responseData.dbError = saveResult.error;
      }
    }
    
    // Добавляем информацию об изменениях для фронтенда (если ещё не добавлена)
    if (responseData.isMinimalChange && responseData.minimalChanges && !responseData.changesDescription) {
      console.log('📝 Формируем описание изменений для фронтенда...');
      responseData.changesDescription = formatMinimalChangesDescription(responseData.minimalChanges);
      console.log('📋 Описание изменений:', JSON.stringify(responseData.changesDescription, null, 2));
    }

    res.json(responseData);
  } catch (error) {
    console.error('Ошибка генерации графика:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Функция для форматирования описания изменений
function formatChangesDescription(changes) {
  const employeeChanges = {};
  
  changes.forEach(change => {
    if (!employeeChanges[change.employee]) {
      employeeChanges[change.employee] = [];
    }
    
    const date = new Date(change.date).toLocaleDateString('ru-RU');
    const oldShiftText = change.oldShift.type === 'OFF' ? 'Выходной' : 
                       `${change.oldShift.start}-${change.oldShift.end}`;
    const newShiftText = change.newShift.type === 'OFF' ? 'Выходной' : 
                       `${change.newShift.start}-${change.newShift.end}`;
    
    employeeChanges[change.employee].push({
      date,
      oldShift: oldShiftText,
      newShift: newShiftText,
      changeType: change.changeType
    });
  });
  
  return employeeChanges;
}

// Функция для форматирования описания минимальных изменений
function formatMinimalChangesDescription(changes) {
  const employeeChanges = {};
  
  changes.forEach(change => {
    if (!employeeChanges[change.employee]) {
      employeeChanges[change.employee] = [];
    }
    
    const date = new Date(change.date).toLocaleDateString('ru-RU');
    const oldShiftText = change.oldShift.type === 'OFF' ? 'Выходной' : 
                       `${change.oldShift.start || ''}-${change.oldShift.end || ''}${change.oldShift.hours ? ` (${change.oldShift.hours}ч)` : ''}`;
    const newShiftText = change.newShift.type === 'OFF' ? 'Выходной' : 
                       change.newShift.type === 'vacation' ? 'Отпуск' :
                       `${change.newShift.start || ''}-${change.newShift.end || ''}${change.newShift.hours ? ` (${change.newShift.hours}ч)` : ''}`;
    
    employeeChanges[change.employee].push({
      date,
      oldShift: oldShiftText,
      newShift: newShiftText,
      reason: change.reason,
      changeType: 'minimal'
    });
  });
  
  return employeeChanges;
}

// API маршрут для главной страницы
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

// API маршрут для загрузки Excel файлов
app.get('/api/download/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  res.download(filename, (err) => {
    if (err) {
      res.status(404).json({ error: 'Файл не найден' });
    }
  });
});

// API маршрут для удаления графика/версии
app.delete('/api/schedule/:scheduleId', requireAuth, async (req, res) => {
  try {
    const { scheduleId } = req.params;
    
    // Проверяем что график существует
    const schedule = await prisma.schedule.findUnique({
      where: { id: parseInt(scheduleId) }
    });

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'График не найден' });
    }

    // Проверяем есть ли дочерние версии (которые ссылаются на этот как на parent)
    const childVersions = await prisma.schedule.findMany({
      where: { parentId: parseInt(scheduleId) }
    });

    // Если есть дочерние версии, нельзя удалить родительскую
    if (childVersions.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Нельзя удалить версию, от которой есть более новые версии' 
      });
    }

    // Удаляем график (каскадно удалятся смены и статистика)
    await prisma.schedule.delete({
      where: { id: parseInt(scheduleId) }
    });

    res.json({ 
      success: true, 
      message: `График версия ${schedule.version} удален`
    });
  } catch (error) {
    console.error('Ошибка удаления графика:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API маршрут для получения всех версий конкретного графика
app.get('/api/schedule-versions/:year/:month', requireAuth, async (req, res) => {
  try {
    const { year, month } = req.params;
    
    const schedules = await prisma.schedule.findMany({
      where: {
        year: parseInt(year),
        month: parseInt(month)
      },
      orderBy: { version: 'desc' },
      include: {
        parent: {
          select: { id: true, version: true }
        }
      }
    });

    const versions = schedules.map(schedule => ({
      id: schedule.id,
      version: schedule.version,
      name: schedule.name,
      parentVersion: schedule.parent?.version,
      createdAt: schedule.createdAt,
      status: schedule.status
    }));

    res.json({ success: true, versions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API маршрут для загрузки графика по ID
app.get('/api/schedule/id/:scheduleId', requireAuth, async (req, res) => {
  try {
    const { scheduleId } = req.params;
    
    const schedule = await prisma.schedule.findUnique({
      where: { id: parseInt(scheduleId) },
      include: {
        organization: true,
        parent: {
          select: { id: true, version: true, name: true }
        },
        shifts: {
          include: { employee: true }
        },
        statistics: {
          include: { employee: true }
        }
      }
    });

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'График не найден' });
    }

    // Преобразуем данные в нужный формат
    const result = await transformScheduleToResponse(schedule);
    res.json({ success: true, ...result });
    
  } catch (error) {
    console.error('Ошибка загрузки графика по ID:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API маршрут для полной очистки всех графиков
app.delete('/api/schedules/clear-all', requireAuth, async (req, res) => {
  try {
    // Считаем количество записей перед удалением
    const countResult = await prisma.schedule.count();
    
    // Удаляем все графики (каскадно удалятся связанные смены и статистика)
    await prisma.schedule.deleteMany({});
    
    res.json({ 
      success: true, 
      deletedCount: countResult,
      message: `Удалено ${countResult} версий графиков`
    });
  } catch (error) {
    console.error('Ошибка полной очистки графиков:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Функция для преобразования данных из БД в формат ответа
async function transformScheduleToResponse(schedule) {
  const employees = [];
  const scheduleData = {};
  const employeeHours = {};
  const detailedStats = {};

  // Группируем смены по сотрудникам
  const employeeShifts = {};
  schedule.shifts.forEach(shift => {
    const employeeName = shift.employee.fullName;
    if (!employees.includes(employeeName)) {
      employees.push(employeeName);
    }
    
    if (!employeeShifts[employeeName]) {
      employeeShifts[employeeName] = [];
    }
    employeeShifts[employeeName].push(shift);
  });

  // Преобразуем в формат schedule
  employees.forEach(emp => {
    scheduleData[emp] = {};
    employeeHours[emp] = 0; // Инициализируем ноль
    
    const shifts = employeeShifts[emp] || [];
    shifts.forEach(shift => {
      const dateKey = shift.workDate.toISOString().split('T')[0];
      const shiftType = SHIFT_TYPES[shift.shiftType] || SHIFT_TYPES.DAY;
      
      // ВСЕГДА используем эталонные значения времени из конфигурации
      const startTime = shiftType.start;
      const endTime = shiftType.end;
      
      scheduleData[emp][dateKey] = {
        type: shift.shiftType,
        start: startTime,
        end: endTime,
        hours: parseFloat(shift.hours),
        location: shift.location === 'HOME' ? 'дом' : 'офис'
      };
      // УБИРАЕМ накопление часов - используем только данные из БД статистики
    });
  });

  // Преобразуем статистику (используем данные из БД, а не пересчитываем)
  schedule.statistics.forEach(stat => {
    const employeeName = stat.employee.fullName;
    detailedStats[employeeName] = {
      totalHours: stat.totalHours,
      workDays: stat.workDays,
      offDays: stat.offDays,
      dutyShifts: stat.dutyShifts,
      weekendShifts: stat.weekendShifts,
      vacationDays: stat.vacationDays,
      maxConsecutiveWork: stat.maxConsecutiveWork
    };
    
    // Используем ТОЛЬКО статистику из БД для итоговых часов
    employeeHours[employeeName] = stat.totalHours;
  });

  return {
    schedule: scheduleData,
    employees,
    employeeHours,
    detailedStats,
    year: schedule.year,
    month: schedule.month,
    version: schedule.version,
    parentVersion: schedule.parent?.version,
    targetHours: schedule.targetHours,
    filename: `график_${schedule.year}_${String(schedule.month).padStart(2, '0')}_v${schedule.version}.xlsx`
  };
}

// API маршрут для удаления всех версий графика за месяц
app.delete('/api/delete-month/:year/:month', requireAuth, async (req, res) => {
  try {
    const { year, month } = req.params;
    
    // Находим все графики за этот период
    const schedules = await prisma.schedule.findMany({
      where: {
        year: parseInt(year),
        month: parseInt(month)
      }
    });

    if (schedules.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Графики за указанный период не найдены' 
      });
    }

    // Удаляем все графики (каскадно удалятся смены и статистика)
    await prisma.schedule.deleteMany({
      where: {
        year: parseInt(year),
        month: parseInt(month)
      }
    });

    res.json({ 
      success: true, 
      message: `Удалено ${schedules.length} версий графика за ${month}/${year}`
    });
  } catch (error) {
    console.error('Ошибка удаления месячного графика:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});

// Универсальная функция для пересчета времени смены при изменении часов
function recalculateShiftTime(shift, newHours) {
  const shiftType = SHIFT_TYPES[shift.type];
  if (!shiftType) return shift;
  
  // Для всех типов смен используем эталонное время начала и конца
  const newShift = { 
    ...shift, 
    hours: newHours,
    start: shiftType.start,
    end: shiftType.end
  };
  
  // Смены с фиксированным временем - НЕ пересчитываем время, только обновляем часы
  const fixedTimeShifts = [
    'MONDAY_HOME',        // 11:00-22:00 фиксированно
    'DUTY_HOME',          // 16:00-02:00 фиксированно
    'WEEKEND'             // 13:00-23:00 фиксированно
  ];
  
  if (fixedTimeShifts.includes(shift.type)) {
    // Для фиксированных смен всегда используем эталонное время
    return newShift;
  }
  
  // Для смен с переменным временем (дневные, пятница и т.д.) пересчитываем время окончания
  if (shiftType.start && shiftType.start !== '' && newHours !== shiftType.hours) {
    const startTime = moment(shiftType.start, 'HH:mm');
    
    // Для смен с обедом добавляем 45 минут
    const hasLunchBreak = ['DAY', 'FRIDAY', 'PRE_HOLIDAY', 'SUPERVISOR_DAY', 'SUPERVISOR_FRIDAY', 'SUPERVISOR_PRE_HOLIDAY'].includes(shift.type);
    const totalMinutes = newHours * 60 + (hasLunchBreak ? 45 : 0);
    
    const endTime = startTime.clone().add(totalMinutes, 'minutes');
    newShift.end = endTime.format('HH:mm');
  }
  
  return newShift;
}

// === API МАРШРУТЫ ДЛЯ АВТОРИЗАЦИИ ===

// Маршрут для входа в систему
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === AUTH_CREDENTIALS.username && password === AUTH_CREDENTIALS.password) {
    req.session.authenticated = true;
    req.session.username = username;
    res.json({ success: true, message: 'Авторизация успешна' });
  } else {
    res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
  }
});

// Маршрут для выхода из системы
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ success: false, error: 'Ошибка при выходе из системы' });
    } else {
      res.json({ success: true, message: 'Выход выполнен успешно' });
    }
  });
});

// Маршрут для проверки статуса авторизации
app.get('/api/auth-status', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.json({ authenticated: true, username: req.session.username });
  } else {
    res.json({ authenticated: false });
  }
});

// Функция для получения отображаемых часов (время смены без обеденного перерыва)
function getDisplayHours(shiftType, start, end) {
  if (!start || !end) return 0;
  
  // Для ночных смен и смен через полночь
  if (end === '02:00' || end === '23:00' || start === '13:00' || start === '16:00') {
    const startTime = moment(start, 'HH:mm');
    let endTime = moment(end, 'HH:mm');
    
    // Если окончание меньше начала, значит смена через полночь
    if (endTime.isBefore(startTime)) {
      endTime.add(1, 'day');
    }
    
    const totalHours = endTime.diff(startTime, 'hours', true);
    return Math.round(totalHours * 4) / 4; // Округляем до 0.25
  }
  
  // Для остальных смен используем расчетные часы из SHIFT_TYPES
  return SHIFT_TYPES[shiftType]?.hours || 0;
}

// НОВАЯ функция для дополнительной балансировки справедливости
function rebalanceFairness(schedule, employees, year, month) {
  const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
  
  // Анализируем текущее распределение
  const stats = {};
  employees.forEach(emp => {
    stats[emp] = {
      weekendWork: 0,
      dutyShifts: 0,
      mondayHome: 0
    };
    
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      const date = moment(dateKey);
      const dayOfWeek = date.day();
      const shift = schedule[emp][dateKey];
      
      if (shift && shift.type !== 'OFF' && shift.type !== 'vacation') {
        // Подсчет работы в выходные (суббота/воскресенье + праздники)
        if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) {
          stats[emp].weekendWork++;
        }
        
        // Подсчет дежурств
        if (shift.type === 'DUTY_HOME' || shift.type === 'WEEKEND') {
          stats[emp].dutyShifts++;
        }
        
        // Подсчет удаленки в понедельник
        if (shift.type === 'MONDAY_HOME') {
          stats[emp].mondayHome++;
        }
      }
    }
  });
  
  console.log('📊 Анализ распределения ДО балансировки:');
  employees.forEach(emp => {
    console.log(`  ${emp}: выходные=${stats[emp].weekendWork}, дежурства=${stats[emp].dutyShifts}, пн_дом=${stats[emp].mondayHome}`);
  });
  
  // БАЛАНСИРОВКА 1: Выходные работы
  const avgWeekendWork = employees.reduce((sum, emp) => sum + stats[emp].weekendWork, 0) / employees.length;
  const weekendOverloaded = employees.filter(emp => stats[emp].weekendWork > avgWeekendWork + 0.5);
  const weekendUnderloaded = employees.filter(emp => stats[emp].weekendWork < avgWeekendWork - 0.5);
  
  console.log(`📈 Средняя работа в выходные: ${avgWeekendWork.toFixed(1)}`);
  console.log(`🔴 Перегруженные выходными: ${weekendOverloaded.join(', ')}`);
  console.log(`🟢 Недогруженные выходными: ${weekendUnderloaded.join(', ')}`);
  
  // Перераспределяем выходные смены
  for (const overloaded of weekendOverloaded) {
    for (const underloaded of weekendUnderloaded) {
      if (stats[overloaded].weekendWork <= stats[underloaded].weekendWork) break;
      
      // Ищем выходную смену у перегруженного
      for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
        const date = moment(dateKey);
        const dayOfWeek = date.day();
        
        if ((dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) && 
            schedule[overloaded][dateKey].type !== 'OFF' &&
            schedule[underloaded][dateKey].type === 'OFF') {
          
          // Проверяем возможность обмена
          if (hasMinimumRest(getLastShiftEnd(schedule, underloaded, dateKey), `${dateKey} ${schedule[overloaded][dateKey].start}`) &&
              hasMinimumRest(`${dateKey} ${schedule[overloaded][dateKey].end}`, getNextShiftStart(schedule, underloaded, dateKey))) {
            
            console.log(`🔄 Перераспределение выходной ${dateKey}: ${overloaded} -> ${underloaded}`);
            
            // Обмениваем смены
            const temp = schedule[overloaded][dateKey];
            schedule[overloaded][dateKey] = schedule[underloaded][dateKey];
            schedule[underloaded][dateKey] = temp;
            
            stats[overloaded].weekendWork--;
            stats[underloaded].weekendWork++;
            
            break;
          }
        }
      }
    }
  }
  
  // БАЛАНСИРОВКА 2: Дежурства
  const avgDutyShifts = employees.reduce((sum, emp) => sum + stats[emp].dutyShifts, 0) / employees.length;
  const dutyOverloaded = employees.filter(emp => stats[emp].dutyShifts > avgDutyShifts + 0.5);
  const dutyUnderloaded = employees.filter(emp => stats[emp].dutyShifts < avgDutyShifts - 0.5);
  
  console.log(`📈 Среднее количество дежурств: ${avgDutyShifts.toFixed(1)}`);
  console.log(`🔴 Перегруженные дежурствами: ${dutyOverloaded.join(', ')}`);
  console.log(`🟢 Недогруженные дежурствами: ${dutyUnderloaded.join(', ')}`);
  
  // Перераспределяем дежурства (аналогично выходным)
  for (const overloaded of dutyOverloaded) {
    for (const underloaded of dutyUnderloaded) {
      if (stats[overloaded].dutyShifts <= stats[underloaded].dutyShifts) break;
      
      for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
        const overloadedShift = schedule[overloaded][dateKey];
        const underloadedShift = schedule[underloaded][dateKey];
        
        if ((overloadedShift.type === 'DUTY_HOME' || overloadedShift.type === 'WEEKEND') &&
            underloadedShift.type === 'DAY') {
          
          // Проверяем возможность обмена дневной смены на дежурство
          console.log(`🔄 Перераспределение дежурства ${dateKey}: ${overloaded} -> ${underloaded}`);
          
          // Обмениваем смены
          const temp = schedule[overloaded][dateKey];
          schedule[overloaded][dateKey] = schedule[underloaded][dateKey];
          schedule[underloaded][dateKey] = temp;
          
          stats[overloaded].dutyShifts--;
          stats[underloaded].dutyShifts++;
          
          break;
        }
      }
    }
  }
  
  console.log('📊 Анализ распределения ПОСЛЕ балансировки:');
  employees.forEach(emp => {
    // Пересчитываем статистику
    let weekendWork = 0, dutyShifts = 0, mondayHome = 0;
    
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      const date = moment(dateKey);
      const dayOfWeek = date.day();
      const shift = schedule[emp][dateKey];
      
      if (shift && shift.type !== 'OFF' && shift.type !== 'vacation') {
        if (dayOfWeek === 0 || dayOfWeek === 6 || isHoliday(dateKey)) {
          weekendWork++;
        }
        if (shift.type === 'DUTY_HOME' || shift.type === 'WEEKEND') {
          dutyShifts++;
        }
        if (shift.type === 'MONDAY_HOME') {
          mondayHome++;
        }
      }
    }
    
    console.log(`  ${emp}: выходные=${weekendWork}, дежурства=${dutyShifts}, пн_дом=${mondayHome}`);
  });
}

// НОВАЯ функция для валидации консистентности графика
function validateScheduleConsistency(schedule, employees, year, month) {
  let fixedErrors = 0;
  const daysInMonth = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
  
  console.log('🔍 Проверяем консистентность типов смен и часов...');
  
  employees.forEach(emp => {
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = moment(`${year}-${month}-${day}`, 'YYYY-M-D').format('YYYY-MM-DD');
      const shift = schedule[emp][dateKey];
      
      if (shift && shift.type !== 'OFF' && shift.type !== 'vacation') {
        const expectedConfig = SHIFT_TYPES[shift.type];
        
        if (!expectedConfig) {
          console.error(`❌ Неизвестный тип смены: ${shift.type} для ${emp} на ${dateKey}`);
          // Заменяем на стандартную дневную смену
          schedule[emp][dateKey] = {
            type: 'DAY',
            hours: SHIFT_TYPES.DAY.hours,
            start: SHIFT_TYPES.DAY.start,
            end: SHIFT_TYPES.DAY.end,
            location: SHIFT_TYPES.DAY.location
          };
          fixedErrors++;
          continue;
        }
        
        // Проверяем часы
        if (shift.hours !== expectedConfig.hours) {
          console.warn(`⚠️ Несоответствие часов для ${emp} на ${dateKey}: ${shift.type} должно быть ${expectedConfig.hours}ч, а не ${shift.hours}ч`);
          shift.hours = expectedConfig.hours;
          fixedErrors++;
        }
        
        // Проверяем время начала
        if (shift.start !== expectedConfig.start) {
          console.warn(`⚠️ Несоответствие времени начала для ${emp} на ${dateKey}: ${shift.type} должно начинаться в ${expectedConfig.start}, а не в ${shift.start}`);
          shift.start = expectedConfig.start;
          fixedErrors++;
        }
        
        // Проверяем время окончания
        if (shift.end !== expectedConfig.end) {
          console.warn(`⚠️ Несоответствие времени окончания для ${emp} на ${dateKey}: ${shift.type} должно заканчиваться в ${expectedConfig.end}, а не в ${shift.end}`);
          shift.end = expectedConfig.end;
          fixedErrors++;
        }
        
        // Проверяем локацию
        if (shift.location !== expectedConfig.location) {
          console.warn(`⚠️ Несоответствие локации для ${emp} на ${dateKey}: ${shift.type} должно быть ${expectedConfig.location}, а не ${shift.location}`);
          shift.location = expectedConfig.location;
          fixedErrors++;
        }
      }
    }
  });
  
  // Проверяем правильность понедельников
  console.log('🔍 Проверяем правильность понедельников (2+2 смены)...');
  
  for (let day = 1; day <= daysInMonth; day++) {
    const date = moment(`${year}-${month}-${day}`, 'YYYY-M-D');
    const dayOfWeek = date.day();
    const dateKey = date.format('YYYY-MM-DD');
    
    if (dayOfWeek === 1) { // Понедельник
      const shiftsThisDay = {};
      employees.forEach(emp => {
        const shift = schedule[emp][dateKey];
        if (shift && shift.type !== 'OFF' && shift.type !== 'vacation') {
          shiftsThisDay[shift.type] = (shiftsThisDay[shift.type] || 0) + 1;
        }
      });
      
      console.log(`📅 Понедельник ${dateKey}: смены =`, shiftsThisDay);
      
      // Проверяем что именно 2 MONDAY_HOME и 2 DUTY_HOME
      if (shiftsThisDay['MONDAY_HOME'] !== 2) {
        console.warn(`⚠️ В понедельник ${dateKey} должно быть 2 смены MONDAY_HOME, а не ${shiftsThisDay['MONDAY_HOME'] || 0}`);
      }
      
      if (shiftsThisDay['DUTY_HOME'] !== 2) {
        console.warn(`⚠️ В понедельник ${dateKey} должно быть 2 смены DUTY_HOME, а не ${shiftsThisDay['DUTY_HOME'] || 0}`);
      }
    }
  }
  
  if (fixedErrors > 0) {
    console.log(`✅ Исправлено ${fixedErrors} ошибок консистентности`);
  } else {
    console.log(`✅ Консистентность графика проверена, ошибок не найдено`);
  }
}
