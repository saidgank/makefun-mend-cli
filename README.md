# makefun-mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/saidgank/makefun-mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/saidgank/makefun-mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads a patch as a unified diff, a set of SEARCH/REPLACE blocks, a V4A patch or JSON editor calls, finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace, full-whitespace), and writes every change or none, printing what it changed or why it failed. `SPEC.md` in this repository is the whole contract mend implements: the command line, the exit codes and output lines, safe paths, format detection, per-format parsing, tiered matching with tier-2 re-indentation, CRLF and missing-final-newline handling, and all-or-nothing writes across the whole patch.

## Run it

```sh
node main.ts [options] [PATCH]   # apply a patch file, or standard input when PATCH is absent or -
node check.ts <practice.json>    # run the public practice set against main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=kvcj2dy8&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
