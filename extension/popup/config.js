const APP_ENV = 'development';

const CONFIG = {
  development: {
    API_BASE: 'http://localhost:8000'
  },
  production: {
    API_BASE: 'https://nexuskitty.onrender.com'
  }
};

const API_BASE = CONFIG[APP_ENV].API_BASE;
