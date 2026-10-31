-- Метка «сообщение клиенту отправляется сейчас»: запрос сотрудника и worker не отправляют одну цепочку дважды.
ALTER TABLE `PaymentRequest` ADD COLUMN `sendingAt` DATETIME(3) NULL;
