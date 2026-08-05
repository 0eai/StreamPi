import crypto from 'crypto';
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { API_KEY, DATABASE_URL } from './config.js';

// ==========================================
// FIREBASE — client SDK only, no service-account.json anywhere on this node
// ==========================================
const fbApp = initializeApp({ databaseURL: DATABASE_URL });
export const fbDb = getDatabase(fbApp);
export const API_KEY_HASH = crypto.createHash('sha256').update(API_KEY).digest('hex');
