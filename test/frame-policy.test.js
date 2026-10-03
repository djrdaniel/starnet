/* Pure exact-ancestor policy checks; no station data or live provider. */
'use strict';
const A = require('./_assert.js');
const { FLO_ORIGIN, staticFrameHeaders } = require('../sidecar/frame-policy.js');
const locked = { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" };
A.eq(staticFrameHeaders(FLO_ORIGIN), { 'Content-Security-Policy': "frame-ancestors 'self' " + FLO_ORIGIN }, 'exact Flo origin is allowed by CSP');
A.eq(staticFrameHeaders(' ' + FLO_ORIGIN + ' '), staticFrameHeaders(FLO_ORIGIN), 'environment whitespace is harmless');
for (const value of [undefined, null, '', '*', 'http:', 'https://example.com', 'http://0.0.0.0:8765',
  'http://localhost:8765', 'http://127.0.0.1:8766', FLO_ORIGIN + '/', FLO_ORIGIN + '/#company',
  FLO_ORIGIN + ' https://example.com', FLO_ORIGIN + '; frame-ancestors *', FLO_ORIGIN + '\r\nX-Test: bad',
  FLO_ORIGIN + '@evil.example', [FLO_ORIGIN], { origin: FLO_ORIGIN }]) {
  A.eq(staticFrameHeaders(value), locked, 'invalid or absent origin preserves both frame protections: ' + JSON.stringify(value));
}
A.report('frame-policy.test');
