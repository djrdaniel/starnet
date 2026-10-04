# Flo station operator bridge

## Native operation integration — 4 October 2026

The owner's current direction supersedes the fixed four-worker controller below.
Flo admits an objective and controls its exact operation; StarNet's actual host
now directs the native crew, recruitment, saved tasks/sessions, additive Build and
worker artifact production. The integrated station remains the primary Flo
Company view. Historical Company workflows and their saved evidence remain in
Advanced / recovery and cannot run alongside an active native operation.

`flo-operator` and `flo-operator-worker` are host-only profiles. JSON ingress,
ordinary chat completions, prompts and worker results cannot mint their private
in-process authority. They use the configured ChatGPT OAuth model with high
reasoning at execution, preserving the owner's saved model, medium reasoning,
ask-for-approval and trusted-project settings. Public web, named-worker jailed
files and memory are available; the lead additionally has native recruitment,
delegation, tasks, sessions, Dossier text and validated additive construction.
Foreground parallel delegation stays within one cancellable pass. Background
dispatch and worker recursion are withheld.

Native operation goals retain this explicit host-owned scope instead of the
ordinary single-domain task heuristic. Mentioning `itch.io` in a broad commerce
goal cannot hide delegation/search or pin all fetching to that one host. The
allowed native tools are advertised directly, and commerce children retain the
native worker's bounded clock/tool allowance. Ordinary single-site inspections
keep their narrower domain policy; public-reader private-address, credential-URL
and DNS-rebinding checks still apply.

The host shares a durable 160-tool-call / 15-minute allowance across each pass;
the lead has 80 calls / 48 iterations and each worker 40 calls / 32 iterations /
10 minutes. Ongoing operations reassess after 15 minutes, with up to 48 passes
per operation per UTC day and 32 real crew. Existing unscoped routines,
Nightshift and workshops remain held by the protected managed policy. Paid
provider/media fallbacks, arbitrary connectors, shell/host paths, DJR control,
publication, purchases and supplier/customer messages gain no authority.

`station.manual` reads the bundled source-native manual and the integration
contract. `station.layout` supplies actual coordinates, catalog footprints,
bindings and routing. `commerce.read` reads bounded saved Flo connection,
product, launch and release facts through one fixed authenticated loopback GET;
it performs no live store request, and supplies no credentials or buyer data.
Connection evidence and staged files must never be presented as sales or profit.

| Route | Native operation contract |
| --- | --- |
| `GET /v1/station/operations` | Read actual operation, worker activity, limits, events, verified files and exact action receipts; starts nothing. |
| `POST /v1/station/operations` | Confirm one objective, unique `request_id` and `once` or `ongoing` mode; enroll and verify the actual native save before admission. |
| `POST /v1/station/operations/{id}/action` | Confirm `pause`, `resume` or `stop` for the exact current operation and request ID. Pause/stop cancel the lead and its children. |
| `GET /v1/station/operations/{id}/artifacts/{id}` | Reopen the worker-jail file, compare its saved bounded byte count and SHA-256, and return a safe attachment. Changed files require a new delivery receipt. |

The operation ledger commits before provider work and before each shared-budget
tool admission. Final dispatcher preflight/refusal/structured-validation outcomes
and failed reported-file read-back remain durable failures, even if a raw child
or lead says done. Structured repair keeps the original worker clock and parent
cancellation link. Interrupted work, recovered backup uncertainty and
unproven writes stop for inspection; unknown commands are never blindly replayed.
Between proven completed passes, an ongoing goal retains its saved due time over
restart. A completed `once` operation means a bounded pass finished, not income.

Native mutations use StarNet's canonical save revision, real WorldModel/class/
workstream engines, private prewrite recovery snapshots and read-back receipts.
Recent mutation receipts retire into hashed replay tombstones. Mirror recovery
verifies the original enrollment even after receipt rollover without creating a
new mutation. Browser saves preserve host proof; roster/routing writes require
the real canonical revision. Native SSE refresh adopts current crew/floor without
replaying a stale roster or overwriting open COMMS/history/drafts/editors.

Validation is registered in the standard fast and HTTP manifests. The dedicated
native adapter/refresh, operation, auth/download, save-policy, commerce-reader,
dispatch-lifecycle and real-host stale-mirror suites cover these boundaries using
isolated temporary workspaces. Actual bench proof is recorded in Flo's
`docs/WORKLOG.md`; test fixtures do not establish commercial readiness.

## Earlier fixed handoff implementation — retained provenance

Implemented on 2026-10-03 for the owner's Flo workspace and commerce station setup. Flo owns the owner-facing goal, job admission, evidence and automatic handoffs between the existing Chief of Staff, Research, Product Lead (`strategist`, acting as Product Manager) and QA Reviewer. Publishing, spending and production changes remain owner decisions. Native worker-to-worker dispatch remains disabled.

All routes use StarNet's existing loopback Host pin and strong `/v1` bearer authentication. They never vend the native browser launch token, OAuth credentials or private worker personas. Read routes do not start work or grant authority.

| Route | Contract |
| --- | --- |
| `GET /v1/station/operator` | Bounded source-derived goal, journey, grounding, saved/active routing, crew settings and native manual. `operation` reports the protected host admission policy. `pending_consents` contains the actual native prompt ids, expiration, tool, scope and reviewable arguments. `owner_reviews` lists disk-validated native workshop builds awaiting review; their current action is opening the real station. |
| `POST /v1/station/consents/{runId}/{promptId}` | Exactly `{ "decision": "once" }` or `{ "decision": "deny" }`. Calls the same native consent finisher as the station. Broader decisions are rejected; expired or settled prompts return 409. Approve once also requires `args_complete:true`; truncated, unsupported or redacted/private arguments can only be denied through Flo. |
| `POST /v1/station/consents/{runId}/{promptId}/ack` | Exactly `{ "displayed": true }`, after Flo actually renders the concrete request. Reuses the native one-shot display extension. Repeating it cannot add more time. |
| `POST /v1/station/brief` | Exactly `expected_revision`, `direction`, `owner_context`, `standing_orders`. Text fields are nonempty and at most 280 characters. Uses the canonical native Dossier and Understanding engines, updates the four existing workers' Flo contract while preserving their other instructions/settings, and mirrors the resulting native knowledge. |
| `GET /v1/station/setup` | Reviews one fixed, source-native additive commerce room and four-bay line, with its expected save revision and proposal hash. Preserves every existing room and prop. The native Build sandbox has no construction currency ledger; existing execution spend limits and grants remain unchanged. |
| `POST /v1/station/setup` | Exactly `{ "confirm": true, "expected_revision": N, "proposal_hash": "…" }`. Applies only the reviewed fixed proposal, validates native geometry/routing, saves through native revision CAS and updates the native router. Reapplying an already installed floor does not duplicate it or increment the canonical revision. |

Before any brief or floor mutation, setup retains a bounded local prewrite snapshot in the protected `_flo.setup.backups` sibling directory. The snapshot includes the prior canonical save and relevant knowledge/roster/routing/policy files; it excludes credential stores. Files use the native durable writer's 0600 mode. Write or mirror failures return a truthful error and retain the backup; the Flo admission policy remains fail closed.

The protected `_flo.operation.json` policy is persisted **before** warming native grounding or routing. In `flo-managed` mode, autonomous/unscoped runs cannot reach a provider; existing bounded `flo-text` and `flo-research` jobs remain available. Nightshift stands down before spending its leash, workshop stands down before claiming backlog, silent browser idle runs and direct autonomous writes are refused, and posture mirrors cannot automatically grant an additional away-build lane. Saved posture, permission grants and timer intent are preserved. Explicit watched user runs continue to use native ask-for-approval. The policy is loaded before scheduler construction and survives restart; corrupt policy fails closed.

For an existing native station, the owner-controlled launcher must back up current data, stop the verified idle old process, enable the protected policy through `makeFloOperation(...).enable()` and then start the new host. This avoids a startup interval in which an old nightshift policy could admit unscoped work. Enabling the helper does not write a dossier, change a grant or start a job.

The floor is native infrastructure and its routing is validated and persisted. Automatic handoffs currently run through Flo's individual worker jobs. The presence of belts does not enable native unscoped chain execution or widen a child worker's capabilities.

Validation: `test/station-operator.test.js`, `test/station-operator.http.test.js`, `test/station-setup.test.js` and `test/station-setup.http.test.js` cover authentication, actual native consent once/deny/ack, expiry and replay, bounded complete argument review, canonical provenance, CAS, private backups, preserved settings/artifacts, fixed Build/routing and restart-persistent pre-provider admission refusal. HTTP fixtures use isolated temporary workspaces and a child-only fake OAuth provider; they cannot touch the owner's workspace or account.

## Embedded station telemetry clock correction

The first embedded station check returned successful authenticated polling APIs while its EventSource returned 403 `forbidden token`. Windows/browser time was about 58 minutes behind WSL/server time. Independent UTC checks agreed with WSL; Windows reported an unsynchronized Local CMOS Clock. The browser was minting a fresh scoped SSE ticket on every reconnect, but its two-minute expiration was already in the verifier's past. No elevated Windows clock settings were changed. The client fix handles the persistent clock difference without weakening ticket verification.

`ApiTicket.refreshClock()` now reads the local health response's HTTP Date, anchors ticket expiration to that server clock and advances it with monotonic page time. The station bridge performs this bounded read before each EventSource attempt, including after a server clock correction; a concurrent re-entry cannot open a second stream. This leaves HMAC authentication, the two-minute TTL, replay protection and genuine LINK DOWN behavior intact. Reloading the native iframe loads the static JavaScript fix; it does not require restarting active workers.

`test/apiticket-clock.test.js` covers one-hour skew, browser wall-clock changes, verifier rollback followed by refresh, TTL bounds, failed probes and single-use rejection. The real production bridge closure is exercised in `test/channels.sse.test.js` for concurrent probes, reconnection and disconnect during a probe. The seven-suite ticket/auth/telemetry regression gate passes.

## Applied bench setup and browser verification

The Flo integration operator applied the reviewed setup to `/home/djrdev/starnet-flo/workspaces` on 2026-10-03. The owner brief used expected canonical revision 88 and completed at revision 89. The reviewed fixed floor proposal then used revision 89 and completed at revision 90. The protected prewrite backups are `_flo.setup.backups/1791065060717-31272135-2335-4594-a3c1-eddabc985c9b.json` (revision 88, before the brief) and `_flo.setup.backups/1791065060918-8754cbf0-f45d-4c4d-b954-c7351312e418.json` (revision 89, before the floor). A read-only metadata check confirmed each prior revision and file mode 0600. The source-development tests used separate temporary workspaces throughout.

The resulting native floor retains HOME and all eleven prior props and adds the ten-prop commerce room, its four individually bound worker bays and validated belt routing. Existing native Away builds, including the prototype decision brief awaiting owner review, remain intact. Worker identities, role settings, ChatGPT OAuth provider, saved GPT model/reasoning choices, ask-for-approval and trusted-project execution profiles were preserved. Saved autonomy posture, existing grants and execution budgets were preserved. The protected runtime policy is `flo-managed`; setup did not enable native worker-to-worker delegation or broader publishing, spending or production authority.

After the static ticket-clock fix and a fresh Company iframe reload, the actual browser accessibility state confirmed **UPLINK ONLINE**, **COMMS online**, a **LIVE FEED**, and all four real crew members **IDLE** after Flo's individually named jobs had finished. This verifies the embedded native station's live telemetry connection in addition to its previously successful operator APIs and durable floor/crew state.
