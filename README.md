# Software Factory

A spec-driven assembly line of Claude Code agents for one Owner. You give it a pitch; agents
specify, plan, build, verify and integrate work items on their own branches, and nothing
reaches `main` or your laptop without your signature.

The `factory` CLI has three faces:

- **Laptop commands for the Owner** — `new`, `adopt`, `approve`, `merge`, `deploy`, `pause`,
  `resume`, `upgrade`, `inbox`, `keygen`, `config set`, `release`. Every Owner-only action
  needs a terminal and a passphrase-protected SSH signature.
- **Dispatcher** — `factory dispatch` / `factory run`: a deterministic state machine over
  GitHub issue labels that launches one Claude Code session per station.
- **In-session enforcement** — `factory hook …` and `factory mcp`: path, read and command
  guards, event logging and the station tools agents use.

This repository also holds the material the CLI installs into projects (`factory/`: role
files, permission rules, CI workflows, Spec Kit templates, constitution, TypeScript profile)
and the TLA+ model of the critical property (`formal/`).

> **Status**: under construction (Phase 0, delivery slice 1 of ~36). The commands above are
> specified but not yet implemented.

## Requirements

- Node.js 24, npm, git ≥ 2.34, OpenSSH ≥ 8.2
- [`gh`](https://cli.github.com/) logged in as the Owner
- Claude Code on the Pro plan
- Java 17 only to run the model checker locally (CI has it)

## Install

```bash
npm ci --ignore-scripts && npm run build && npm link   # provides `factory`
factory keygen                                         # Owner signing key (passphrase required)
```

Then follow [the quickstart](specs/001-software-factory/quickstart.md).

## Development

```bash
npm test               # unit, property, contract and integration tests
npm run test:e2e       # end-to-end runs against a sample project (manual)
npm run test:formal    # TLC on formal/Dispatcher.tla (needs Java 17 and tla2tools.jar)
npm run lint && npm run typecheck
```

Design documents: [spec](specs/001-software-factory/spec.md) ·
[plan](specs/001-software-factory/plan.md) · [tasks](specs/001-software-factory/tasks.md) ·
[constitution](.specify/memory/constitution.md).

## Licence

[MIT](LICENSE)
