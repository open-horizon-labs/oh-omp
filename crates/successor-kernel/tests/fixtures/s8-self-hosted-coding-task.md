# S8 disposable Rust coding task

You are operating inside a temporary Rust crate created only for this test.

Task:
1. Inspect the workspace and find the failing unit test.
2. Read the failing unit test's assertion and the buggy function in `src/lib.rs`. Change only that function's buggy return expression to the smallest correction that makes the existing assertion pass.

3. Do not edit any other source text, manifest text, comments, test code, or formatting.
4. Run the logical executable `cargo` with the focused command `test --quiet` from the crate workspace.
5. If that focused test fails after your first mutation, inspect the failure and repair at most once.
6. Finish only after `cargo test --quiet` passes.
7. After your final mutation, your final tool call before finishing must run `cargo test --quiet` again, and its reported `exit_code` must be `0`.

Bounds:
- Use inspection tools before mutating.
- Use `edit` or `write` for the source mutation.
- Use `bash` only for logical executable `cargo` and arguments `test --quiet`.
- Do not run broad or unrelated commands.
