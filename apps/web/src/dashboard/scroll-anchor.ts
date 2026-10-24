/** Сохраняем видимую запись, даже если над ней появились новые строки. Только для фоновых данных. */
export function captureDashboardScroll(): (() => void) | null {
  const root = document.querySelector<HTMLElement>('.page.dashboard');
  if (!root) return null;
  const restores: (() => void)[] = [];
  const capture = (container: HTMLElement | null) => {
    const y = container ? container.scrollTop : window.scrollY;
    if (y <= 0) return;
    const x = container ? container.scrollLeft : window.scrollX;
    const bounds = container?.getBoundingClientRect();
    const top = bounds?.top ?? 0; const bottom = bounds?.bottom ?? window.innerHeight;
    const candidates = [...(container ?? root).querySelectorAll<HTMLElement>('[data-dashboard-anchor]')]
      .map(el => ({ key: el.dataset.dashboardAnchor, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
      .filter(el => el.bottom > top && el.top < bottom)
      .sort((a,b) => Number(a.key?.startsWith('block:')) - Number(b.key?.startsWith('block:')));
    restores.push(() => {
      const parent = container ?? root;
      if (!parent.isConnected) return;
      const elements = [...parent.querySelectorAll<HTMLElement>('[data-dashboard-anchor]')];
      let delta = 0; let found = false;
      for (const anchor of candidates) {
        const element = elements.find(el => el.dataset.dashboardAnchor === anchor.key);
        if (element) { delta = element.getBoundingClientRect().top - anchor.top; found = true; break; }
      }
      if (found && Math.abs(delta) <= .5) return;
      if (container) container.scrollTo({ left: x, top: found ? container.scrollTop + delta : y, behavior: 'instant' });
      else window.scrollTo({ left: x, top: found ? window.scrollY + delta : y, behavior: 'instant' });
    });
  };
  // Сначала внутренние списки, затем страница: её якорь уже учитывает восстановленный список.
  for (const container of root.querySelectorAll<HTMLElement>('.dashboard-action-log, .client-timeline, .act-scroll, .call-inline-scroll')) capture(container);
  capture(null);
  return restores.length ? () => restores.forEach(restore => restore()) : null;
}
