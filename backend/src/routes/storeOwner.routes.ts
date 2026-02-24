import { Router } from 'express';
import { signupComplete } from '../controllers/storeOwner.controller.js';

const router = Router();

router.post('/signup/complete', signupComplete);

export default router;
