// TEMPLATE - copy to config.js and fill in, or better: run
//   python scripts/sync_extension_config.py
// which generates extension/popup/config.js from backend/.env.
//
// config.js holds EXTENSION_API_KEY and is git-ignored on purpose: this
// repository is public, and the key is a shared secret that the backend
// verifies on every /api/* request (see verify_extension_key() in
// backend/app/main.py). Anyone with the key can call the API.
//
// Never hardcode the key in popup.js or commit config.js.

const APP_ENV = 'development';

const CONFIG = {
  development: {
    API_BASE: 'http://localhost:8000',
    EXTENSION_API_KEY: '',
  },
  production: {
    API_BASE: 'https://nexuskitty.onrender.com',
    EXTENSION_API_KEY: '',
  },
};

const API_BASE = CONFIG[APP_ENV].API_BASE;

const EXTENSION_API_KEY = (CONFIG[APP_ENV].EXTENSION_API_KEY || '').trim();
