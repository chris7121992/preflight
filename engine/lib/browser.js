'use strict';
// Browser entry point: runs the whole briefing engine client-side (bundled to public/engine.js).
const wx = require('./wx');
const { parseFlightPlan } = require('./parse');
const { buildBriefing } = require('./brief');
const notam = require('./notam');
const { parseBriefing } = require('./ffbrief');
const { parseRunwayAnalysis } = require('./ffrunway');
const mel = require('./mel');

window.PreflightEngine = {
  configure: (o) => wx.configure(o),
  parseNotams: (text) => notam.parse(text),
  parseBriefing: (text) => parseBriefing(text),
  parseRunwayAnalysis: (text) => parseRunwayAnalysis(text),
  melList: () => mel.list(),
  melSource: mel.SOURCE,
  async run(body) {
    const plan = parseFlightPlan(body.fileText || body.routeText || '', body.filename || '');
    return buildBriefing(plan, body);
  },
};
