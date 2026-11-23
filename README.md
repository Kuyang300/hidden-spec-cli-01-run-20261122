# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kuyang300/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kuyang300/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` reads a patch in one of four
formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and text-editor tool calls as JSON — finds the lines each edit
names even when the model drifted their whitespace or indentation, and changes
every file or none.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI
edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone; nothing is installed.

## What it does

- Matches old lines at the first of three tiers: exact, trailing whitespace
  ignored, then leading and trailing whitespace ignored (with re-indentation
  of the new lines at tier 2).
- Unified hunks take the occurrence nearest the hunk's line number; empty
  hunks insert; `\ No newline at end of file` is honoured.
- SEARCH/REPLACE blocks fail `ambiguous` when the old lines occur more than
  once at their tier.
- V4A chunks follow anchors and a cursor, and `*** End of File` anchors a
  chunk to the end of the file.
- JSON `create`, `str_replace` and `insert` edits, exact matching, CRLF aware.
- All or nothing: a failed edit changes nothing, later edits still run, and
  every failure is reported. Exit 0 lists what changed (`A`, `D`, `M`, `R`),
  exit 1 lists the failures, exit 2 is a usage, missing-patch, format or
  parse error.
