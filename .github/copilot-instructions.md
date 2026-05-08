# Copilot instructions for `actionsdesk/user-sync-okta`

This is a single-purpose GitHub Action (Node 24 runtime, TypeScript, bundled with `@vercel/ncc`) that reconciles GitHub Enterprise membership against the assignments of one Okta application and removes any enterprise member whose verified domain emails are not in that app.

## Build / lint / test

- `npm install` — install deps.
- `npm run lint` — `tsc --noEmit` (the only static check).
- `npm run build` — type-check **and** rebundle `dist/` via ncc. **Always run before committing source changes**: the CI workflow (`.github/workflows/build.yml`) fails if the committed `dist/` does not match a fresh build.
- `npm run package` — ncc bundle only, no type-check.
- `npm test` — `node --test`. There are currently no test files; if you add tests, place them next to sources as `*.test.ts` and add a build step to compile them, or use `tsx`/`ts-node` via `node --test --import`.

There is no single-test command beyond what `node --test` itself supports (`node --test path/to/file`).

## Architecture (read these files together)

The flow lives in three files; understanding any one of them in isolation is misleading.

1. **`src/main.ts`** — orchestrator. Two-phase design:
   - **Phase 1 (always runs):** fetch Okta app users → fetch GitHub consumed-licenses → diff into `matched` / `toRemove` / `missingEmails`. Produces the dry-run report and the job summary.
   - **Phase 2 (only when `dry-run=false`):** drift protection + actual removal. **Do not collapse these phases.** The two-layer drift check (refreshed snapshot, then per-user live re-check) is the safety net that biases toward preserving access; on any error in the per-user check the user is **spared, not removed**, and added to `driftSpared`.
2. **`src/okta.ts`** — `OktaClient`. Uses `SSWS` token auth. The bulk source of truth is `GET /api/v1/apps/{appId}/users` (covers direct + group-push assignments — that is why the action does not enumerate groups). Per-user re-check uses `GET /api/v1/users?search=…` then `GET /api/v1/apps/{appId}/users/{userId}` (404 ⇒ unassigned).
3. **`src/github.ts`** — `GitHubClient`. REST for paginated `GET /enterprises/{enterprise}/consumed-licenses` (header `X-GitHub-Api-Version: 2026-03-10`). GraphQL for everything else: `enterprise(slug:)` → enterprise node ID, `user(login:)` → user node ID, `removeEnterpriseMember(input: { enterpriseId, userId })`.

`src/http.ts` — shared `parseNextLink` (RFC 5988); both clients import it. Keep new pagination helpers here, not duplicated.

## Conventions

- **HTTP client is `undici.request`**, not `node-fetch`/`axios`/`@actions/http-client`. Match that style for new calls; centralise auth in the client class's private `headers()` / `restHeaders()` method.
- **Email matching is always lowercased** via `.toLowerCase()` and stored in `Set<string>`. Never compare emails case-sensitively.
- **`DEPROVISIONED` Okta users are filtered out** at every layer (bulk collect, search-by-email, app-user check). New Okta call paths must do the same.
- **GitHub-side filtering**: only consider entries with `github_com_user === true` and `license_type === "enterprise"` (lowercased). Server-licensed and Visual-Studio-only entries are intentionally ignored.
- **Failure semantics matter**:
  - Users with no usable `github_com_verified_domain_emails` ⇒ `core.error` for each, then `core.setFailed` at the end (after the report has been written). This surfaces them for manual triage rather than silently skipping.
  - Errors during a per-user drift re-check ⇒ `core.warning` + add to `driftSpared` + `continue`. **Never** let an Okta failure cause a removal.
  - Errors during the actual GraphQL removal ⇒ `core.error` for that login + `continue`; do not fail the whole run.
- **Dry-run is the default** (`dry-run=true`). When changing the orchestrator, preserve the invariant that no `removeEnterpriseMember` mutation is ever issued unless `dry-run=false`.
- **`dist/` is committed** and validated by CI. Edit only `src/`, then `npm run build`, then commit both.
- **Inputs are list-tolerant where typed as lists** (`email-domain-filter`): use `parseList()` in `main.ts` (splits on newline or comma, trims, drops empties). Reuse it for any future list inputs.
- **Action metadata** lives in `action.yml`; `runs.using` is `node24` and `main` is `dist/index.js`. If you change the runtime, update `package.json` engines / `@types/node` accordingly.

## Things that look optional but aren't

- The `X-GitHub-Api-Version: 2026-03-10` header on the consumed-licenses call — the schema (`github_com_verified_domain_emails`) is API-version-bound.
- The `removeEnterpriseMember` mutation requires `enterpriseId` and `userId` as **node IDs**, not slugs/logins; both lookups (`enterprise(slug:)`, `user(login:)`) are mandatory and cached per-run only at the call site.
- The CI "verify dist/ is up to date" step uses `git status --porcelain dist`; ncc output must be byte-stable for a given source — do not introduce timestamps or random IDs into the bundle.
