# Phase 7 composed verification

Run from the repository root against the migrated PostgreSQL/PostGIS test database
and CACHE Redis configured by `apps/api/test/setup-env.ts`. The wire tests need a
Node runtime with native WebSocket, as do the existing transport tests. Fixtures
use unique users and production Swipe/Event approval services; only socket token
verification is substituted. Cleanup follows the existing transactional audit
trigger convention, so use an isolated test database and run serially.

```sh
pnpm --filter @tripwith/api exec tsc -p test/phase7-chat-realtime/tsconfig.json
pnpm --filter @tripwith/api test -- --runInBand --runTestsByPath test/phase7-chat-realtime/composed.int-spec.ts
pnpm --filter @tripwith/api test -- --runInBand --testPathPattern='src/(auth|swipes|events|database|chat)/.*\.spec\.ts$'
pnpm --filter @tripwith/api test -- --runInBand --testPathPattern='src/(swipes|events|database|chat)/.*\.int-spec\.ts$'
```

The dedicated TypeScript configuration checks the new test directory, which the
normal API typecheck excludes. Jest discovers it through the existing test root.
No production code, schema, dependencies or global test configuration changed.

| Required behavior | Verification |
| --- | --- |
| Reciprocal MATCH provisioning to authorized durable/realtime chat | New composed Swipe scenario: existing room/members, local and remote frames, outsider denial |
| Manual/automatic EVENT approval to host/member chat | New durable and realtime parameterized scenarios; membership checked before resolver repair; host has no participant row |
| Completion read-only, cancellation closed | Both new EVENT scenarios plus `src/chat/event-chat.int-spec.ts` and `src/events/join-requests.int-spec.ts` |
| Commit followed by failed publication, seq recovery | New publication-failure scenario: durable success, local delivery, remote absence, reconnect catch-up and retry |
| Concurrent duplicate sends consume one position | New same-user/two-instance race; durable row/counter check; `src/chat/chat.int-spec.ts` covers rollback and changed payloads |
| Monotonic caller/room-scoped cursors | New concurrent cursor scenario and Swipe retry preservation; existing durable suite covers send/cursor races |
| Revoked recipients receive no later content | New later committed message after remote membership revocation; existing transport suite covers queued references, unmatch, blocks and account revocation |
| Multi-instance presence/disconnect/TTL/Redis loss | Reuse `src/chat/presence/presence.store.int-spec.ts` (including actual 60-second lease expiry) and `src/chat/transport/chat.gateway.int-spec.ts` (wire subscriptions and multiple API instances/devices) |
| Swipe, Events, Auth and DB regressions | Existing unit and integration selections above, including final-seat races, audit rollback, auth guards and schema/entity fidelity |

The composed harness assembles production services/gateways with the production
RealtimeModule and RedisIoAdapter. It does not boot AppModule or exercise Firebase
verification; the existing Auth tests provide separate regression evidence.

At the task checkout, `ChatGateway.authorize` still rejects all EVENT rooms with
`CHAT_ROOM_UNSUPPORTED`, despite ChatService now owning EVENT lifecycle policy.
The two new EVENT wire scenarios assert required successful access and should
expose this gap on a permitted host; they are not skipped or marked expected-fail.
`PresenceService.authorize` independently retains an all-EVENT rejection guard.
These guards require work by the production file owner.

Local execution: the dedicated typecheck and 224 unit tests passed. All seven new
integration cases stopped at PostgreSQL connection setup (`EPERM`); no composed
database or wire assertions executed. Existing live regressions also encounter
PostgreSQL connection denial and Redis connection closure. Host execution remains
required; earlier dependency handoffs are not evidence that these new tests pass.
