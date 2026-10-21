import { PROGRAM_FROM_KEYWORD } from '@btx24/shared';
import { convertText, rulesFromBizproc } from './bizproc-import.js';

const branch = (title: string, cond: unknown[] | null, children: unknown[]) => ({
  Type: 'IfElseBranchActivity',
  Properties: { Title: title, ...(cond ? { fieldcondition: cond } : { truecondition: '1' }) },
  Children: children,
});
const setVar = (v: Record<string, string>) => ({ Type: 'SetVariableActivity', Properties: { VariableValue: v } });
const setField = (value: string) => ({ Type: 'SetFieldActivity', Properties: { FieldValue: { UF_CRM_1754995195231: value } } });
const send = (text: string, files: string[] = [], type = 'disk') => ({
  Type: 'ImOpenLinesSend',
  Properties: { Title: 'msg', MessageText: text, AttachmentType: type, Attachment: files },
});

const template = [
  {
    Type: 'SequentialWorkflowActivity',
    Children: [
      { Type: 'CrmTimelineCommentAdd', Properties: { CommentText: 'ЗАПУСК БП' } },
      {
        Type: 'IfElseActivity',
        Children: [
          branch('Программы', [['tovary', 'contain', 'Алатырь', '0'], ['tovary', 'contain', 'Мужской круг', '1']], [
            setField('86'),
            setVar({ dealtype: 'Программы' }),
            { Type: 'IfElseActivity', Children: [branch('Алатырь', [['tovary', 'contain', 'Алатырь', '0']], [setVar({ programm: 'Алатырь' })])] },
          ]),
          branch('Суточная', [['tovary', 'contain', 'Суточная', '0']], [setField('90'), setVar({ dealtype: 'Суточная', programm: 'Суточная аренда дома на воде' })]),
          branch('Не определено', null, [{ Type: 'IMNotifyActivity', Properties: { MessageSite: 'Не определен тип' } }]),
        ],
      },
      {
        Type: 'IfElseActivity',
        Children: [
          branch('Программы', [['dealtype', '=', 'Программы', '0']], [
            send('', ['92152', '141098']),
            send('Подтверждаем бронь на имя {=Document:CONTACT.NAME}: {=Document:UF_CRM_1754843339886}, {=Variable:programm > printable}, дом {=Document:UF_CRM_1754996940869}', [''], 'file'),
            send('Уточните номер авто'),
            { Type: 'CrmTimelineCommentAdd', Properties: { CommentText: 'длинный текст в комментарий' } },
          ]),
          branch('Суточная', [['dealtype', '=', 'Суточная', '0']], [send('Суточная: {=Document:OPPORTUNITY} рублей')]),
        ],
      },
    ],
  },
];

describe('rulesFromBizproc', () => {
  it('turns BP branches into booking types with keywords, deal type value, program and confirmation chain', () => {
    const rules = rulesFromBizproc(template);
    expect(rules).toEqual([
      {
        id: 'programs',
        title: 'Программы',
        keywords: ['Алатырь', 'Мужской круг'],
        dealTypeValue: '86',
        program: PROGRAM_FROM_KEYWORD,
        confirmation: [
          { text: '', files: [{ id: 92152, name: 'Файл Диска #92152' }, { id: 141098, name: 'Файл Диска #141098' }] },
          { text: 'Подтверждаем бронь на имя {client_name}: {date_start}, {program}, дом {house}', files: [] },
          { text: 'Уточните номер авто', files: [] },
        ],
      },
      {
        id: 'daily',
        title: 'Суточная',
        keywords: ['Суточная'],
        dealTypeValue: '90',
        program: 'Суточная аренда дома на воде',
        confirmation: [{ text: 'Суточная: {amount} рублей', files: [] }],
      },
    ]);
  });

  it('converts BP expressions to template variables', () => {
    expect(convertText('{=Document:UF_CRM_1754843349378}–{=Document:UF_CRM_1754843387505}, {=Document:UF_CRM_1754826067667} гостей')).toBe('{time_start}–{time_end}, {guests} гостей');
  });

  it('empty or foreign template → no rules', () => {
    expect(rulesFromBizproc([])).toEqual([]);
    expect(rulesFromBizproc({ Type: 'SequentialWorkflowActivity', Children: [] })).toEqual([]);
  });
});
