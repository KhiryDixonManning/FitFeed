export const PYTHON_API = window.location.hostname === 'localhost'
  ? '/api'
  : 'https://fitfeed-api-production.up.railway.app';

// Ping Railway every 4 minutes to prevent cold starts during demo
if (window.location.hostname !== 'localhost') {
  setInterval(() => {
    fetch(`${PYTHON_API}/health`).catch(() => {});
  }, 4 * 60 * 1000);
}
