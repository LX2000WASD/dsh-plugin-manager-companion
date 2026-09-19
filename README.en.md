# dsh-plugin-manager-companion

Companion to the official DSH plugin manager: pre-install quality gate, deep environment diagnostics, plugin marketplace, and skills/presets management.

[![npm version](https://img.shields.io/npm/v/dsh-plugin-manager-companion)](https://www.npmjs.com/package/dsh-plugin-manager-companion)
[![license](https://img.shields.io/npm/l/dsh-plugin-manager-companion)](LICENSE)

This is a rewrite of [dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager) (0.6.3, unmaintained).
DSH 0.1.6-alpha.2 ships its own plugin management page, which retired the old approach of shadowing that page and writing profile state directly.

[中文说明（主文档）](./README.md)

## Screenshots

| | |
|---|---|
| ![Environment console · Health check](docs/images/readme/01-console-health.png)<br>Five diagnostic layers: grouped findings, per-item evidence, graded fixes | ![Environment console · Environments](docs/images/readme/02-console-envs.png)<br>Starting, stopping, copying and restoring across profiles |
| ![Plugin marketplace](docs/images/readme/03-marketplace.png)<br>Marketplace cards: risk and installability badges, detail with verification evidence | ![Official plugin page](docs/images/readme/04-official-plugin-page.png)<br>Managing this plugin’s configuration inside the official plugin page |

## Contents

- [What it does, and what it deliberately does not](#what-it-does-and-what-it-deliberately-does-not)
- [Install](#install)
- [The three capabilities](#the-three-capabilities)
- [Command line](#command-line)
- [Platform support](#platform-support)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## What it does, and what it deliberately does not

The official plugin manager’s README lists what it cannot do. This plugin covers those gaps and nothing else.

| Capability | Official | This plugin |
|---|---|---|
| Enabling/disabling bundles and plugin rows | Yes | Not touched |
| Installing and removing bundles | Yes | Not touched (the quality gate runs before install) |
| Hosting plugin configuration pages | Provides the slots | Registers into them |
| Static checks before install | No | **Quality gate** |
| Environment diagnostics | No | **Environment console · Health check** |
| Changing another profile | Explicitly out of scope | **Environment console · Environments** |
| Loading plain plugin modules | Documented as a file operation | Skills and presets installation |
| Version listing and update detection | Explicitly out of scope | Plugin marketplace |

Every write goes through an official channel: the official `pluginManager` service for the current environment,
and the official `runPluginCommand` (same profile write lock) across environments.
This plugin never writes `cordis.patch.yml` and never invokes pnpm directly.

The four gaps the official README states verbatim, the feature each one maps to, and how this plugin should retire a feature
if the official manager ever covers it, are recorded in [docs/OFFICIAL-DEPENDENCIES.md](docs/OFFICIAL-DEPENDENCIES.md) §1-F.

## Install

```sh
dsh plugin --profile <name> add dsh-plugin-manager-companion@latest
```

Requires **DSH >= 0.1.6-alpha.2**. Enable it on the plugin management page and restart that profile.

## The three capabilities

### Quality gate before install

It attaches to the official `installBundle` "install but do not enable" switch, so a rejected install leaves the environment untouched:

1. `inspect(spec)` — official: what does this spec point at;
2. `installBundle(spec, { enabled: false })` — official: staged, not activated;
3. scan the staged package — this plugin: undeclared imports, declared but not installed, official packages declared as plain `dependencies` (which install a second copy inside the profile and hijack the official loader row), unresolvable entry points;
4. reject → `removeBundle`; accept → `setBundleEnabled`.

### Environment console

One settings page with three sub-pages:

- **Health check**: five layers, each finding carrying evidence (file and line, or a runtime object), with three disposition levels — safe to fix automatically, needs confirmation, report only. Every finding expands to show why it was reported.
  The layers are L1 dependencies, L2 composition, L3 runtime, L4 consistency, L5 ecosystem. When a layer did not run, its counter shows “not checked” rather than 0.
- **Environments**: every profile on the machine with its run state (process and port); start (terminal window or background), stop, create, rename, delete, copy plugins between profiles, and export / diff / restore backups.
- **Settings**: this plugin’s own configuration, stored through the official settings service and edited in the UI, with no file editing.

### Marketplace, skills and presets

The marketplace page shows the community index. Search covers name, repository, topics and description; sorting covers stars,
last update and recent momentum. Cards carry risk and installability badges (community pick, manual install required, not a plugin).
Installation goes through the quality gate and the official channel. Verification conclusions and risk details come from the index
itself, with links to the original reports.

The skills and presets page manages the `SKILL.md` files and agent presets installed through this plugin: listing records, re-fetching, and uninstalling.

## Command line

`dshpmc` exposes the same capabilities as the UI, for three situations: scripts and CI, terminal-first use, and the escape hatch
when the UI cannot open.

```sh
dshpmc analyze --profile <name>   # five-layer health check; exit code 1 when issues are found
dshpmc list    --profile <name>   # layer stack, dependencies, installed skills and presets
dshpmc install | remove | update | mount | uninstall-kind
```

`update <name>` rewrites the specifier to `@latest` and reinstalls: `dsh plugin add` without a version does not upgrade an already
declared range, and `pnpm update` only re-resolves inside that range, so crossing versions requires rewriting the specifier.
The whole upgrade goes through the same protected path as a click in the UI.

`analyze` does not need a running instance: it reads from disk, so an environment whose configuration is broken still gets a root cause
with file and line. When a key layer could not run, it says the conclusion is incomplete instead of reporting health.

An agent running inside the host does not use the command line for plugin writes: the guard rejects bare `dsh plugin` / `pnpm`
mutation commands and points at the official `plugin_manager` tool. `dshpmc` uses the same pnpm channel as that tool, so it is not intercepted.

## Platform support

Every gate runs on Linux. Per-platform status, stated as facts.

**Linux**: verified on real machines — unit tests plus two end-to-end scripts.

**Windows x64**: the host supports Windows; the platform-specific safety fixes (built-in environment name casing, process-tree termination, quoted command lines, the `.cmd` entry point, terminal fallback, cross-platform test entry) were each independently re-verified on real win32 Node. The following are unverified or known not to hold:

- Terminal window mode requires Windows Terminal (`wt`); without it the instance falls back to background start and says so.
- File permission bits (0600/0700) are no-ops on Windows; the launch log holding the access token is protected only by the profile directory ACL.
- “Stop environment” is `taskkill /T /F`, a forced process-tree termination rather than a graceful stop (the result text says so); a force-killed instance does not run its own shutdown cleanup.
- Installing skill or preset repositories that contain symlinks needs Developer Mode or administrator rights.
- The two end-to-end scripts and the visual tooling depend on bash and Chrome/CDP; on Windows the gate entry point is `pnpm test`.
- Unverified: ACLs, service accounts, sessions without a desktop; when enterprise policy disables PowerShell the process facts are unreadable, and the UI then says “unknown”.

**macOS**: unverified. Its default filesystem is case-insensitive, and the same casing guards used on Windows cover it by the same rule.

## Known limitations

- DSH >= 0.1.6-alpha.2 only. For earlier versions use the 0.6.x line from the old repository.
- The two fixes that would edit the structure of `cordis.patch.yml` (removing a duplicate row, removing an orphan row) only report what to do; the user performs them. This plugin is not a second writer for that file.
- The install guard intercepts agent tool calls, not commands typed into a terminal.
- Sensitive environment-variable filtering is pattern-based, not exhaustive; unmatched forms still reach the subprocess for git-source installs.
- The L3 registration-name conflict check covers profile-local packages only, not official-scope rows.
- The port is known only when the instance command line carries `--port`; a GUI host started on the default port shows “port unknown”.
- The L5 ecosystem layer is a skeleton: it does not use the network and makes no judgement, reported as “not checked”.
- Marketplace index data and risk tiers come from the upstream index; this plugin presents them and does not second-guess them.

## Contributing

Development setup, gates, code layout and the pre-commit checklist are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
The design authority is [docs/DESIGN.md](docs/DESIGN.md); engineering policy is [docs/CODE-POLICY.md](docs/CODE-POLICY.md);
the host/client contract is [docs/REST-CONTRACT.md](docs/REST-CONTRACT.md); the official facts this plugin depends on, with an upgrade checklist, are in [docs/OFFICIAL-DEPENDENCIES.md](docs/OFFICIAL-DEPENDENCIES.md).

## License

MIT
