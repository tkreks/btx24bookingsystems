-- Произвольная оплата: основание, сумма и срок задаёт сотрудник; стадию и поля оплаты сделки не трогает.
ALTER TABLE `PaymentRequest` MODIFY `kind` ENUM('prepayment', 'surcharge', 'custom') NOT NULL;
