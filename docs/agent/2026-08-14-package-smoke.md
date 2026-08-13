# Package smoke test

## Scope

The smoke test used a packed `dsh-tui@0.1.0` tarball and an isolated Harness home under `/tmp`. The local DeepSeek Harness checkout was built before the runtime launch so its profile fallback contained emitted package entry points.

## Commands and results

- `pnpm pack --pack-destination <tmp>` built the package and listed both JavaScript entry points, both declaration files, `cordis.patch.yml`, `README.md`, and `LICENSE`.
- `dsh plugin --profile tui add <tarball>` initialized an isolated profile and installed the tarball as the `dsh-tui` bundle.
- `dsh --profile tui --dump-config` showed `@deepseek-ai/dsh-base` followed by the `code-runtime`, `tui-startup`, and `tui-runtime` rows from `dsh-tui`.
- `dsh --profile tui --help` printed the TUI-specific command help and exited without mounting the runtime.
- `dsh --profile tui` opened the idle composer in a PTY. Ctrl+C restored the cursor and exited with code 0.
- `dsh --profile tui hello` opened the composer, submitted `hello`, showed the direct user message, and rendered the expected `MISSING_CREDENTIAL` turn error because the isolated home had no API key. Ctrl+C restored the cursor and exited with code 0.

## Defect found

The first tarball omitted declarations because `package.json` pointed to `lib/types/` while the standalone tsdown build emitted `lib/*.d.ts`. The manifest now exports and packages the emitted paths. The repeated pack listed both declaration files.

## Remaining release checks

The public-readiness pass still needs automated package linting, CI, documentation, and a real provider-stream test when credentials are available. The keyless PTY smoke proves composition, agent creation, prompt admission, terminal rendering, error projection, and clean shutdown.
