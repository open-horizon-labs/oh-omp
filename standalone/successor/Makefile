.PHONY: build check-rs fmt-rs-check fmt-rs lint-rs cargo-check-rs test-rs fix-rs

build:
	cargo build --workspace --locked

check-rs: fmt-rs-check lint-rs cargo-check-rs

fmt-rs-check:
	cargo fmt --all -- --check

fmt-rs:
	cargo fmt --all

lint-rs:
	cargo clippy --workspace --locked -- -D warnings

cargo-check-rs:
	cargo check --workspace --locked

test-rs:
	cargo test --workspace --all-targets --locked

fix-rs:
	cargo clippy --workspace --fix --allow-dirty --allow-staged -- -D warnings
	cargo fmt --all
