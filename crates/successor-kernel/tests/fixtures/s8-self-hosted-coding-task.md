# S8 disposable Rust coding task

You are operating inside a temporary Rust crate created only for this test.

Task:
1. Inspect the workspace and find the failing unit test.
2. Change only the buggy return expression in `src/lib.rs` to exactly:

```rust
input * 2 + 1
```

3. Do not edit any other source text, manifest text, comments, test code, or formatting.
4. Run the logical executable `cargo` with the focused command `test --quiet` from the crate workspace.
5. If that focused test fails after your first mutation, inspect the failure and repair at most once.
6. Finish only after `cargo test --quiet` passes.

Bounds:
- Use inspection tools before mutating.
- Use `edit` or `write` for the source mutation.
- Use `bash` only for logical executable `cargo` and arguments `test --quiet`.
- Do not run broad or unrelated commands.
