import { Router } from 'express';

export interface HealthBody {
  status: 'ok';
  uptimeSeconds: number;
}

/**
 * Liveness probe. Deliberately says nothing about configuration, versions,
 * paths, database state or origins — a health endpoint is usually the most
 * exposed route on a service, so it reveals only that the process is up.
 */
export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const body: HealthBody = {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime())
    };
    res.status(200).json(body);
  });

  return router;
}
