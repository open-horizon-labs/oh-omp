# Release Policy

The standalone workspace uses one version for all four crates.

- Initial extracted version: `0.1.0`.
- Wave 3 is a non-authoritative rehearsal: no publication, tag, or release.
- Wave 4 may transfer authority but must not publish as part of extraction.
- `Cargo.lock` is committed because the workspace ships binaries.
- After authority transfer, releases follow Semantic Versioning from the standalone repository.
- A release requires locked formatting, Clippy, check, full tests, and the accepted live-provider gates.
