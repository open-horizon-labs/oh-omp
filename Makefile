.PHONY: build check-rs fmt-rs-check fmt-rs lint-rs cargo-check-rs fix-rs

build:
	bun --cwd=packages/coding-agent run build:binary

check-rs: fmt-rs-check lint-rs cargo-check-rs

fmt-rs-check:
	cargo fmt --all -- --check

fmt-rs:
	cargo fmt --all

lint-rs:
	cargo clippy --workspace -- -D warnings

cargo-check-rs:
	cargo check --workspace

fix-rs:
	cargo fmt --all
	cargo clippy --fix --allow-dirty --all-targets --no-deps --allow-staged --broken-code --allow-no-vcs
