# Wave 3 Preparation Record

**Predecessor:** `6ef351ceb9139647d5a9a47669e3559b93e443fc`
**State:** scaffold preparation; source authoritative

Owner decisions:

- destination `open-horizon-labs/successor-agent-kernel`, default branch `main`;
- Cargo author `Open Horizon Labs`;
- preserve existing MIT notices and add 2026 Open Horizon Labs;
- reset standalone workspace version to `0.1.0`.

Preparation discovered:

- destination repository does not exist yet;
- `git-filter-repo` is not globally installed;
- official PyPI current release is 2.47.0; rehearsal uses pinned `uvx`;
- 102 tracked files exist under the four successor crates;
- canonical fixtures are compile-time referenced at `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/`, so their destination path remains unchanged;
- ignored local Wave 1/2 run logs are represented only through new reviewed tracked summaries;
- generated SQLite/WAL state is excluded.

No authority transfer, remote creation, filtering, source deletion, commit, or push occurred during preparation.
