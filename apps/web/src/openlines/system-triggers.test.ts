import { describe, expect, it } from 'vitest';
import type { GroupDto } from '@btx24/shared';
import { systemTriggers } from './TemplatesPage.js';

const files = [{ id: 1, name: 'a.pdf' }, { id: 2, name: 'b.pdf' }];
const group = (payments: Record<string, unknown>, bookingTypes: unknown[]): GroupDto =>
  ({ id: 'g1', name: 'Бани', options: { payments: { invoice: { categoryId: 1 }, ...payments }, bookingTypes } }) as unknown as GroupDto;
const type = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, keywords: ['x'], dealTypeValue: '', program: '', confirmation: [{ text: '', files }], ...extra });

describe('systemTriggers: предоплата по типам брони', () => {
  it('у группы с типами брони и без шаблона — по строке на тип, с «Настроить»; общей строки нет', () => {
    const rows = systemTriggers([group({}, [type('h', 'Почасовая'), type('c', 'Сертификат')])], []);
    const pre = rows.filter((r) => r.key.startsWith('g1:pre'));
    expect(pre.map((r) => r.title)).toEqual(['Ссылка на предоплату · Почасовая', 'Ссылка на предоплату · Сертификат']);
    expect(pre[0]!.files).toBe(2);
    expect(pre[0]!.text).toContain('банный дом');
    expect(pre[1]!.text).toContain('подарочный сертификат');
    expect(pre.every((r) => r.typeEdit)).toBe(true);
  });

  it('своё сообщение типа показывается вместо стандартного', () => {
    const own = [{ text: 'Своё {link}', files: [] }];
    const [row] = systemTriggers([group({}, [type('h', 'Почасовая', { prepayment: own })])], []).filter((r) => r.key.startsWith('g1:pre'));
    expect(row!.text).toBe('Своё {link}');
    expect(row!.typeEdit!.own).toBe(true);
  });

  it('выбран шаблон оплаты группы — общая строка группы, строк по типам нет', () => {
    const pre = systemTriggers([group({ prepaymentTemplateId: 't1' }, [type('h', 'Почасовая')])], []).filter((r) => r.key.startsWith('g1:pre'));
    expect(pre).toHaveLength(1);
    expect(pre[0]!.typeEdit).toBeUndefined();
  });
});
