import { Router } from 'express';
import { internalTick } from '../controllers/loosePrices.controller.js';

// Called by the database scheduler (pg_cron + pg_net) with a shared secret.
const router = Router();
router.post('/tick', internalTick);

export default router;
