-- Назначение шаблона: «payment» — системный шаблон сообщения со ссылкой на оплату; группа выбирает
-- его для предоплаты и доплаты. Существующие шаблоны — шаблоны чатов.
ALTER TABLE `MessageTemplate` ADD COLUMN `purpose` ENUM('chat', 'payment') NOT NULL DEFAULT 'chat';
