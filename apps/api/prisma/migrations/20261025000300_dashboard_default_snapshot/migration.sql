-- По просьбе владельца: заменить прежние личные раскладки сотрудников этого портала
-- снимком дашборда Максима Тармосина от 2026-10-25, совпадающим с DEFAULT_DASHBOARD.
-- Только данные, структура таблиц не меняется. Миграция однократная: новые личные
-- изменения после её применения сохраняются. Другие порталы не затрагиваются.
UPDATE `DashboardLayout` AS d
INNER JOIN `Portal` AS p ON p.`id` = d.`portalId`
SET d.`blocks` = '[{"id":"attention","type":"attention","width":"half","rows":2},{"id":"messengers","type":"messengers","width":"quarter"},{"id":"recentCalls","type":"recentCalls","width":"half"},{"id":"kpiGrid","type":"kpiGrid","width":"quarter","kpi":{"cols":3,"rows":2,"items":["bookingsToday","paidDeals","callsLost","newBookings","removedBookings","callsNew"]}},{"id":"myActivity","type":"myActivity","width":"third"},{"id":"noOpenline","type":"noOpenline","width":"third"},{"id":"needsClose","type":"needsClose","width":"third"}]',
    d.`updatedAt` = UTC_TIMESTAMP(3)
WHERE p.`memberId` = 'eacd473beec8c39f54fd7afd810cd43d';
