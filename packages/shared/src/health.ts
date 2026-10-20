/** Response shape of `GET /api/health` (apps/api HealthController). */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  db: 'up' | 'down';
  time: string;
}
