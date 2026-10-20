import { useEffect, useState } from 'react';
import type { HealthResponse } from '@btx24/shared';

// Временный экран-заглушка: показывает, что фронтенд собран и видит api.
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>Система бронирования</h1>
      {error && <p>API недоступно: {error}</p>}
      {health && (
        <p>
          API: {health.status}, БД: {health.db}, версия {health.version}
        </p>
      )}
    </main>
  );
}
