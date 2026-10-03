/* Prove the optional Flo ancestor on real isolated servers, keeping API auth unchanged. */
'use strict';
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { FLO_ORIGIN } = require('../sidecar/frame-policy.js');

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'flo-frame-', env: { STARNET_FLO_FRAME_ORIGIN: FLO_ORIGIN } });
  await fixture.start();
  try {
    const page = await fetch(fixture.baseUrl + '/');
    A.eq(page.status, 200, 'station app loads');
    A.eq(page.headers.get('content-security-policy'), "frame-ancestors 'self' " + FLO_ORIGIN, 'real app CSP permits only self and exact Flo ancestor');
    A.eq(page.headers.get('x-frame-options'), null, 'obsolete same-origin header does not contradict the exact ancestor opt-in');
    A.eq(page.headers.get('x-content-type-options'), 'nosniff', 'other static protection remains');
    const floApi = await fetch(fixture.baseUrl + '/api/budget/status', { headers: { Origin: FLO_ORIGIN, 'X-StarNet-Token': fixture.token } });
    A.eq(floApi.status, 403, 'Flo parent cannot call the station API even with a token');
    A.eq(floApi.headers.get('access-control-allow-origin'), null, 'Flo receives no API CORS grant');
    const noToken = await fetch(fixture.baseUrl + '/api/budget/status', { headers: { Origin: fixture.baseUrl } });
    A.eq(noToken.status, 403, 'framed app still requires its launch token');
    const sameOrigin = await fixture.request('/api/budget/status');
    A.eq(sameOrigin.status, 200, 'station own origin and token retain API access');
    await fixture.restart({ STARNET_FLO_FRAME_ORIGIN: 'https://evil.example' });
    const rejected = await fetch(fixture.baseUrl + '/');
    A.eq(rejected.headers.get('x-frame-options'), 'SAMEORIGIN', 'remote config fails closed in real server');
    A.eq(rejected.headers.get('content-security-policy'), "frame-ancestors 'self'", 'remote config leaves baseline CSP');
    await fixture.restart({ STARNET_FLO_FRAME_ORIGIN: '' });
    const baseline = await fetch(fixture.baseUrl + '/');
    A.eq(baseline.headers.get('x-frame-options'), 'SAMEORIGIN', 'unconfigured app retains baseline frame header');
    A.eq(baseline.headers.get('content-security-policy'), "frame-ancestors 'self'", 'unconfigured app retains baseline CSP');
  } finally { await fixture.dispose(); }
  A.report('flo-frame.http.test');
})().catch(e => { console.log('FAIL: flo-frame.http.test threw -- ' + (e && e.stack || e)); process.exit(1); });
