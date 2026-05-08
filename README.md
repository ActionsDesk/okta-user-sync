# user-sync-okta

GitHub Action that reconciles GitHub Enterprise membership against one or more Okta groups. Any enterprise member whose verified domain email is **not** present in any of the configured Okta groups is removed from the enterprise via the GraphQL `removeEnterpriseMember` mutation.

Matching is performed on lowercased email addresses from the `github_com_verified_domain_emails` field returned by [`GET /enterprises/{enterprise}/consumed-licenses`](https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/licensing?apiVersion=2026-03-10#list-enterprise-consumed-licenses) (REST API version `2026-03-10`).

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `enterprise` | yes | — | Enterprise slug. |
| `github-token` | yes | — | Token with `enterprise:admin` scope. |
| `okta-domain` | yes | — | Okta domain (e.g. `example.okta.com`, no scheme). |
| `okta-token` | yes | — | Okta API token (`SSWS`) with rights to read group members. |
| `okta-groups` | yes | — | Newline- or comma-separated Okta group IDs. |
| `dry-run` | no | `true` | If `true`, only logs intended removals. Set to `false` to enforce. |
| `email-domain-filter` | no | `""` | Optional comma-separated allowlist of email domains to consider when matching. |

## Outputs

| Name | Description |
| --- | --- |
| `removed-count` | Count of users removed (or that would be removed in dry-run). |
| `removed-logins` | JSON array of GitHub logins removed (or that would be). |
| `drift-spared-logins` | JSON array of GitHub logins spared from removal because a re-check found them in Okta. |

## Behavior

- Iterates `consumed-licenses` paginated; only entries with `github_com_user == true` and `license_type == "enterprise"` are considered.
- Users with **no** usable `github_com_verified_domain_emails` cause the run to fail after the report (so they are surfaced for manual triage).
- Removal uses GraphQL: looks up the enterprise node ID via `enterprise(slug:)` and the user node ID via `user(login:)`, then calls `removeEnterpriseMember`.

## Drift protection

There is an unavoidable window between fetching the Okta snapshot, fetching GitHub membership, and issuing each removal. To bias toward preserving access, the action applies two layered checks immediately before each removal:

1. **Refreshed Okta snapshot** — the Okta groups are re-fetched right before the removal phase. If a candidate's verified email now appears in the refreshed snapshot, removal is skipped.
2. **Per-user authoritative re-check** — for each remaining candidate, the action calls `GET /api/v1/users?search=…` to find the Okta user, then `GET /api/v1/users/{id}/groups` to confirm they are not in any configured group.

Fail-safe: if the per-user re-check itself errors (Okta 5xx, rate limit, network), the user is **spared, not removed** (logged as a warning). All spared logins are reported in `drift-spared-logins` and in the job summary.

## Example workflow

```yaml
name: Reconcile enterprise membership
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:
    inputs:
      dry-run:
        description: Dry run
        required: false
        default: "true"

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: lindluni/user-sync-okta@v1
        with:
          enterprise: my-enterprise
          github-token: ${{ secrets.ENTERPRISE_ADMIN_PAT }}
          okta-domain: example.okta.com
          okta-token: ${{ secrets.OKTA_API_TOKEN }}
          okta-groups: |
            00g1abcd2EFG3hijK4l5
            00g6mnop7QRS8tuvW9x0
          dry-run: ${{ inputs.dry-run || 'true' }}
          email-domain-filter: example.com,corp.example.com
```

## Development

```bash
npm install
npm run build      # type-check + bundle to dist/
```

The bundled `dist/index.js` must be committed for the action to run.
