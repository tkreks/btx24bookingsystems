import { describe, expect, it } from 'vitest';
import { appendTemplate, dropSent, moveStep, newStep, toSteps } from './chain.js';

const file = { id: 'f1', name: 'a.pdf', mime: 'application/pdf', size: 1 };
const template = {
  id: 't',
  name: 'Прайс',
  updatedAt: '',
  steps: [
    { text: 'Добрый день', fileIds: [], files: [] },
    { text: '', fileIds: ['f1'], files: [file] },
  ],
};

describe('message chain', () => {
  it('appends a template, replacing an empty draft step', () => {
    const chain = appendTemplate([newStep('Привет'), newStep()], template);
    expect(chain.map((s) => s.text)).toEqual(['Привет', 'Добрый день', '']);
    expect(chain[2].files).toEqual([file]);
  });
  it('builds the request without empty steps and trims text', () => {
    expect(toSteps([newStep(' a '), newStep(), newStep('', [file])])).toEqual([
      { text: 'a', fileIds: [] },
      { text: '', fileIds: ['f1'] },
    ]);
  });
  it('keeps only unsent steps after a partial send', () => {
    const chain = [newStep('1'), newStep(), newStep('2'), newStep('3')];
    expect(dropSent(chain, 2).map((s) => s.text)).toEqual(['3']);
    expect(dropSent(chain, 3).map((s) => s.text)).toEqual(['']);
  });
  it('reorders within bounds', () => {
    const chain = [newStep('a'), newStep('b')];
    expect(moveStep(chain, 0, 1).map((s) => s.text)).toEqual(['b', 'a']);
    expect(moveStep(chain, 0, -1)).toBe(chain);
  });
});
