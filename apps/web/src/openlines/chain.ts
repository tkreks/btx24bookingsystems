import type { MessageTemplateDto, StoredFileDto, TemplateStepDto } from '@btx24/shared';

/** Шаг цепочки в интерфейсе: текст и уже загруженные вложения. `key` — для React. */
export interface ChainStep {
  key: string;
  text: string;
  files: StoredFileDto[];
}

let seq = 0;
export const newStep = (text = '', files: StoredFileDto[] = []): ChainStep => ({ key: `s${++seq}`, text, files });

/** Шаблон встаёт в конец цепочки; пустой последний шаг (черновик) заменяется. */
export function appendTemplate(chain: ChainStep[], template: MessageTemplateDto): ChainStep[] {
  const base = chain.length && isEmpty(chain[chain.length - 1]) ? chain.slice(0, -1) : chain;
  return [...base, ...template.steps.map((s) => newStep(s.text, s.files))];
}

export const isEmpty = (s: ChainStep) => !s.text.trim() && !s.files.length;

/** Для API: пустые шаги не отправляем. */
export const toSteps = (chain: ChainStep[]): TemplateStepDto[] =>
  chain.filter((s) => !isEmpty(s)).map((s) => ({ text: s.text.trim(), fileIds: s.files.map((f) => f.id) }));

/** После частичной отправки — оставить только неотправленные шаги (пустые не считаются). */
export function dropSent(chain: ChainStep[], sent: number): ChainStep[] {
  const filled = chain.filter((s) => !isEmpty(s));
  const rest = filled.slice(sent);
  return rest.length ? rest : [newStep()];
}

export function moveStep(chain: ChainStep[], index: number, delta: -1 | 1): ChainStep[] {
  const to = index + delta;
  if (to < 0 || to >= chain.length) return chain;
  const next = [...chain];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
