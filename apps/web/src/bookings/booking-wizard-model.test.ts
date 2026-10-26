import { describe, expect, it } from 'vitest';
import { allIssues, firstSection, missingText, reviewTarget, sectionView, visibleSections, type SectionKey, type WizardSnapshot } from './booking-wizard-model.js';

const base: WizardSnapshot = {
  dealMode: 'existing',
  dealFixed: false,
  dealBooked: false,
  groupOk: true,
  groupGiven: false,
  kindMissing: false,
  certificate: false,
  resourceCount: 1,
  slotError: null,
  slotWarning: null,
  certificateError: null,
  goodsError: null,
  goodsWarning: null,
  missingFields: [],
  fieldsError: null,
};
const none = new Set<SectionKey>();

describe('visibleSections', () => {
  it('клиентская, служебная, сертификат', () => {
    expect(visibleSections(base)).toEqual(['who', 'when', 'slot', 'goods', 'fields', 'review']);
    expect(visibleSections({ ...base, dealMode: 'service' })).toEqual(['who', 'when', 'slot', 'comment', 'review']);
    expect(visibleSections({ ...base, certificate: true })).toEqual(['who', 'when', 'certificate', 'review']);
  });
});

describe('firstSection — матрица точек входа', () => {
  it('клик по календарю: клиента нет — «Кто»', () => {
    expect(firstSection({ ...base, dealMode: 'none', groupGiven: true })).toBe('who');
  });
  it('встройка сделки «Мастер бронирования»: сделка из встройки — «Группа и дата»', () => {
    expect(firstSection({ ...base, dealFixed: true, resourceCount: 0 })).toBe('when');
  });
  it('шкала во встройке: сделка, группа и ресурс известны — товары', () => {
    expect(firstSection({ ...base, dealFixed: true, groupGiven: true })).toBe('goods');
  });
  it('чат: у клиента есть сделки — выбор сделки; сделок нет («Новая») — группа', () => {
    expect(firstSection({ ...base, resourceCount: 0 })).toBe('who');
    expect(firstSection({ ...base, dealMode: 'new', resourceCount: 0 })).toBe('when');
  });
  it('одна группа и сделка из встройки — ресурс и время; занятый слот — тоже он', () => {
    expect(firstSection({ ...base, dealFixed: true, groupGiven: true, resourceCount: 0 })).toBe('slot');
    expect(firstSection({ ...base, dealFixed: true, groupGiven: true, slotError: 'Баня 1 занята' })).toBe('slot');
  });
  it('тип сделки не выбран — «Группа и дата», даже если группа известна', () => {
    expect(firstSection({ ...base, dealFixed: true, groupGiven: true, kindMissing: true })).toBe('when');
  });
});

describe('sectionView', () => {
  it('без группы ресурс, товары и поля недоступны с подсказкой', () => {
    const s = { ...base, groupOk: false };
    expect(sectionView('slot', s, none, none)).toEqual({ key: 'slot', status: 'locked', note: 'Сначала выберите группу и дату' });
    expect(sectionView('goods', s, none, none).status).toBe('locked');
    expect(sectionView('fields', { ...base, dealMode: 'none' }, none, none).note).toBe('Сначала выберите группу и сделку');
  });
  it('незаполненное краснеет только после ухода с раздела', () => {
    const s = { ...base, missingFields: ['Гостей', 'Программа'] };
    expect(sectionView('fields', s, none, new Set(['fields'])).status).toBe('empty');
    expect(sectionView('fields', s, new Set(['fields']), new Set(['fields']))).toEqual({ key: 'fields', status: 'error', note: 'Не заполнено 2: Гостей, Программа' });
  });
  it('тех. окно — предупреждение, занято — ошибка сразу', () => {
    expect(sectionView('slot', { ...base, slotWarning: 'тех. окно' }, none, none).status).toBe('warning');
    expect(sectionView('slot', { ...base, slotError: 'занято' }, none, none).status).toBe('error');
  });
  it('по сделке уже есть бронь — предупреждение у «Кто»', () => {
    expect(sectionView('who', { ...base, dealBooked: true }, none, none).status).toBe('warning');
  });
  it('товары: до первого открытия — «не выбрано», потом — готово', () => {
    expect(sectionView('goods', base, none, none).status).toBe('empty');
    expect(sectionView('goods', base, none, new Set(['goods'])).status).toBe('done');
  });
  it('проверка закрыта, пока есть проблемы; подсказка с именами полей', () => {
    expect(sectionView('review', { ...base, missingFields: ['Гостей'] }, none, none).note).toBe('Сначала заполните: Гостей');
    expect(sectionView('review', { ...base, resourceCount: 0 }, none, none).note).toBe('Заполните разделы выше');
    expect(sectionView('review', base, none, none).status).toBe('empty');
  });
});

describe('allIssues / reviewTarget', () => {
  it('по порядку разделов; служебной поля не нужны', () => {
    const s = { ...base, dealMode: 'none' as const, resourceCount: 0, missingFields: ['Гостей'] };
    expect(allIssues(s).map((i) => i.key)).toEqual(['who', 'slot', 'fields']);
    expect(reviewTarget(s)).toBe('who');
    expect(allIssues({ ...base, dealMode: 'service', missingFields: ['Гостей'], goodsError: 'x' })).toEqual([]);
    expect(reviewTarget(base)).toBe('review');
  });
  it('поля ещё грузятся — на проверку нельзя', () => {
    expect(allIssues({ ...base, missingFields: null })[0]).toEqual({ key: 'fields', text: 'Поля сделки ещё загружаются' });
  });
});

describe('missingText', () => {
  it('до трёх имён, дальше +N', () => {
    expect(missingText(['А', 'Б', 'В', 'Г', 'Д'])).toBe('Не заполнено 5: А, Б, В +2');
  });
});
