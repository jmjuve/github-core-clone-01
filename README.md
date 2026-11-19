# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jmjuve/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jmjuve/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP, all sharing one in-memory store. Node 22, stdlib only — no git binary, no package, no outside service. Deterministic: no wall clock or randomness in any state.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port and registers it with `$MAKEFUN_ENV_URL` (the make.fun trial env), then serves until the env says done. To smoke-test the server standalone, serve `app.ts` directly on a fixed port:

```sh
node --experimental-strip-types -e "import('./app.ts').then(m => m.createApp().listen(18080, () => console.log('listening 18080')))"
```

Then run the kit's local suite:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token-123 --perf
```

Local practice result: **120/120 checks, 15/15 MCP, perf 150/200 — 950/1000**.

## What it implements

- **Git core, no git binary**: SHA-1 object store (loose objects in memory), packfile read/write (plain + OFS/REF deltas), upload-pack v2 (`ls-refs`, `fetch`, shallow/deepen), receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`), fast-forward-only pushes with per-ref `ok`/`ng` reports.
- **REST v3** (`/api/v3`): repos, branches, commits, contents (create/update/delete with sha checks), issues, labels, comments, pull requests, squash merge with conflict detection (405), pagination via `Link` headers, `X-GitHub-Request-Id` on every reply, 401 without a token, 404 for foreign owners.
- **GraphQL v4** (`/api/graphql`): `viewer`, `repository` (+ `issue`/`issues`/`pullRequest`/`pullRequests`), `node(id:)` Relay global ids, `__type` introspection for `Issue`/`PullRequest`/`Repository`/`SearchType`, `createIssue`/`closeIssue`/`createPullRequest`/`mergePullRequest`/`addComment` mutations, cursor pagination, operation batching, unknown field → 200 with `errors`.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, modern `server/discover` (revision 2026-07-28) plus legacy `initialize`, six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) sharing the REST store.

## Layout

- `main.ts`: the entry ↔ env lifecycle (bind ephemeral port, register, poll `/done`, exit 0). Kept as the starter ships it.
- `app.ts`: the whole server.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vt2v2aqg&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
