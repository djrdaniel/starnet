/* The owner may embed this station in the local Flo Company view. The opt-in
   names one exact ancestor; API origin/token gates remain independent. */
'use strict';

const FLO_ORIGIN = 'http://127.0.0.1:8765';

function staticFrameHeaders(value) {
  // A literal allowlist rejects remote origins, wildcards, lists, paths and header injection.
  // X-Frame-Options cannot express this external ancestor; CSP carries the exact restriction.
  if (typeof value === 'string' && value.trim() === FLO_ORIGIN) {
    return { 'Content-Security-Policy': "frame-ancestors 'self' " + FLO_ORIGIN };
  }
  return { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" };
}

module.exports = { FLO_ORIGIN, staticFrameHeaders };
