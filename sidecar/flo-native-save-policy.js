'use strict';

// A browser constructs a known-field save envelope. Host receipts and setup
// provenance cannot be erased or manufactured by that older serialization.
function preserveNativeHostState(incoming, canonical) {
  const next = Object.assign({}, incoming);
  for (const key of ['floNative', 'floSetup']) {
    delete next[key];
    if (canonical && Object.prototype.hasOwnProperty.call(canonical, key)) next[key] = JSON.parse(JSON.stringify(canonical[key]));
  }
  return next;
}
// Wall-clock freshness does not prove that an attached page has read a host
// recruit or floor change. Native mirrors must carry the actual save revision.
function nativeMirrorCurrent(body, canonical) {
  return !(canonical && canonical.floNative) || !!(body &&
    Number.isSafeInteger(body.floBaseSaveRevision) && body.floBaseSaveRevision === canonical._saveRevision);
}

function nativeRoutingPlan(checked) {
  if (!checked || !checked.ok || !checked.routingOk) throw new Error('The canonical native floor is invalid.');
  const plan = JSON.parse(JSON.stringify(checked.routingPlan));
  for (const key of ['bays', 'dockBays']) for (const bay of plan[key] || []) {
    bay.objects = checked.station.bayObjects(bay.agentId, bay.propId);
  }
  return plan;
}
module.exports = { preserveNativeHostState, nativeMirrorCurrent, nativeRoutingPlan };
