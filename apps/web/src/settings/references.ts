import { useEffect, useState } from 'react';
import type { CatalogDto, DealFieldInfo, DealStageItem } from '@btx24/shared';
import { apiGet } from '../api.js';

type Loadable<T> = { data: T | null; error: string };
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Справочник, загружаемый один раз при открытии формы (или при смене ключа). */
function useReference<T>(path: string | null, fallback: string): Loadable<T> {
  const [state, setState] = useState<{ path: string | null } & Loadable<T>>({ path: null, data: null, error: '' });
  useEffect(() => {
    if (!path) return;
    let active = true;
    apiGet<T>(path).then(
      (data) => active && setState({ path, data, error: '' }),
      (e) => active && setState({ path, data: null, error: message(e, fallback) }),
    );
    return () => {
      active = false;
    };
  }, [path, fallback]);
  return state.path === path ? state : { data: null, error: '' };
}

/** Поля сделки, стадии воронки группы и каталог — для блоков настроек как в прототипе. */
export function useGroupReferences(categoryId: number | null) {
  const fields = useReference<DealFieldInfo[]>('/admin/deal-fields', 'Не удалось загрузить поля сделки');
  const stages = useReference<DealStageItem[]>(
    `/admin/deal-stages?categoryId=${categoryId ?? 0}`,
    'Не удалось загрузить стадии воронки',
  );
  const catalog = useReference<CatalogDto>('/admin/catalog', 'Не удалось загрузить каталог товаров');
  return { fields, stages, catalog };
}
