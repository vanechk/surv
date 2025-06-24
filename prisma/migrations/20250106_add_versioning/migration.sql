-- Добавляем поля версионности в таблицу schedules
ALTER TABLE `schedules` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `schedules` ADD COLUMN `parent_id` INTEGER NULL;
ALTER TABLE `schedules` ADD COLUMN `changes` TEXT NULL;

-- Добавляем внешний ключ для parent_id
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `schedules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Удаляем старый unique constraint и добавляем новый с версией
ALTER TABLE `schedules` DROP INDEX IF EXISTS `unique_schedule`;
ALTER TABLE `schedules` ADD UNIQUE INDEX `unique_schedule_version`(`organization_id`, `year`, `month`, `version`); 