# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG_EN.md)

This project follows [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-08-06

### Added

- Skill workflow **step0 prerequisite check**: verify Node.js 18+, npm/npx, and python3 before generation; note that a Chromium-based browser is required for export
- Export scripts check **Node.js 18+** and **npm** at startup, with clear install guidance when missing or too old
- CLI (`open-kimi-ppt-skills`) refuses to start when the Node.js major version is below 18
- Auto-install **PyYAML** via `pip install --user pyyaml` when missing (same pattern as Pillow / websocket-client)

### Docs

- Added multi-agent / multi-model example screenshots (ChatGPT·Codex + 5.6 Luna, Reasonix + DeepSeek, WorkBuddy, and more)
- Clarified install as “automatic or manual — pick one”, with Windows path notes
- Updated README structure and example images

## [1.0.0] - 2026-08-05

### Added

- Initial release of `open-kimi-ppt-skills`
- PPTD create / edit / replicate, delivering both an editable PPTD project and a PPTX by default
- Browser-side PPTX export (embedded fonts, fade transitions) with optional multimodal visual QA before export
- Local in-browser PPTD editor (`npx open-kimi-ppt-skills serve`)
- CLI to install the skill into `~/.agents/skills` (or another agent directory via `--target`)
