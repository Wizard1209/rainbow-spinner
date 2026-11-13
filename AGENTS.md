# AGENTS.md

rainbow-spinner is a Claude Code mod: a plugin whose hooks draw Claude Code's spinner line in colour styles. `README.md` says what it does and how to run it. `CONTRIBUTING.md` says how to add a style and what a pull request needs. Read both before changing anything.

- **Checks.** Run every command under Development in `README.md`. A change is not done until they pass. If one cannot run where you work, say which and why; do not call it passed.
- **Proof is a terminal.** The tests mock the terminal, so a passing test does not show that a picture reaches a screen. Run the mod in a real terminal (`claude --plugin-dir .`, `/spinner <style>`, a turn that takes a while) and attach what it showed. If you cannot, say so plainly and ask your person for the screenshot. Do not report a terminal as tested when only its environment variables were set.
- **The hooks run inside Claude Code.** They have no Node or DOM APIs: everything outside the module goes through the engine interface `$`. Its types are in `.claude-plugin/types/`, which Claude Code writes only when an interactive session loads the mod from this folder; `claude -p` does not write them. Without that folder the type-check cannot run: ask your person to open `claude --plugin-dir .` once.
- **Generated files.** `hooks/core/atlas.ts` comes from `font/gen_atlas.py` and `hooks/styles/bloom-sprites.ts` from `sprites/gen_sprites.py`. Change the generator, not the file.
- **Words.** English, plain and short. In `bloom`, the seven-lobed leaf is the palmate leaf: use that name in code and in text.
