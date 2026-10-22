-- Общие (системные) шаблоны сообщений: видят все сотрудники портала, меняют администраторы.
-- AlterTable
ALTER TABLE `MessageTemplate` ADD COLUMN `shared` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `MessageTemplate_portalId_shared_idx` ON `MessageTemplate`(`portalId`, `shared`);
