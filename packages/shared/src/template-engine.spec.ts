import { describe, expect, it } from 'vitest';
import { emptyMessageContext, renderMessage, unresolvedTokens } from './template-engine.js';

const confirmation = `Мы с радостью подтверждаем Вашу бронь на имя {{Контакт: Имя}} :

* Дата и время: {{Дата начала визита}} {{Время начала визита}} - {{Дата завершения визита}} {{Время завершения визита}}
* Программа: {=Variable:programm > printable} для {{Количество гостей}} гостей
* Банный дом: {{Банный дом}}
* Стоимость: {{Сумма}} рублей`;

describe('renderMessage', () => {
  const ctx = {
    ...emptyMessageContext(),
    vars: { link: 'https://pay', prepayment: '25 000' },
    dealByTitle: {
      'дата начала визита': '24.10.2026',
      'время начала визита': '14:00',
      'дата завершения визита': '24.10.2026',
      'время завершения визита': '18:00',
      'количество гостей': '6',
      'банный дом': 'Дом на воде 2',
      сумма: '45 000',
    },
    dealByCode: { UF_CRM_1754826067667: '6', OPPORTUNITY: '45 000' },
    contact: { имя: 'Анна', NAME: 'Анна' },
    variables: { programm: 'Алатырь' },
  };

  it('fills the owner’s confirmation template (Bitrix24 and BP syntax)', () => {
    expect(renderMessage(confirmation, ctx)).toBe(`Мы с радостью подтверждаем Вашу бронь на имя Анна :

* Дата и время: 24.10.2026 14:00 - 24.10.2026 18:00
* Программа: Алатырь для 6 гостей
* Банный дом: Дом на воде 2
* Стоимость: 45 000 рублей`);
  });

  it('BP document fields, app variables, aliases; unknown stay visible', () => {
    expect(renderMessage('{=Document:CONTACT.NAME}, гостей {=Document:UF_CRM_1754826067667}', ctx)).toBe('Анна, гостей 6');
    expect(renderMessage('Оплата {prepayment} ₽: {link} / {{Ссылка на оплату}}', ctx)).toBe('Оплата 25 000 ₽: https://pay / https://pay');
    const r = renderMessage('{{Нет такого поля}} {=Variable:x} {unknown}', ctx);
    expect(r).toBe('{{Нет такого поля}} {=Variable:x} {unknown}');
    expect(unresolvedTokens(r)).toEqual(['{{Нет такого поля}}', '{=Variable:x}', '{unknown}']);
  });
});
