// Data source for the in-browser briefing engine.
//   snapshot: folder of weather files refreshed from your computer by "npm run refresh" (free Firebase plan).
//   relay:    optional CORS relay for live API calls instead of the snapshot (e.g. local dev server '/api/relay').
window.PREFLIGHT_CONFIG = {
  snapshot: '/data',
  relay: null,
};
