# Contributing

Contributions are welcome, from people and from their agents. A change is judged by what it shows in a real terminal, not by who wrote it.

## A style of your own

A style is a colour field: a function from a place on the spinner line and a time to a colour. It draws nothing itself; the mod samples it at each letter, or at each pixel column of the word for a picture.

1. Copy `hooks/styles/temper.ts`, the shortest style, to `hooks/styles/<tag>.ts` and export your `Style`. `hooks/core/style.ts` describes every property. `output: 'text'` draws in any terminal; `'image'` draws the word as a picture and needs `loopMs`.
2. Add the style to `STYLES` in `hooks/styles/index.ts`. `/spinner` takes its tag from there.
3. Run `claude plugin test .`. The tests that now fail spell out the list of styles, in `tests/command.test.tsx` and `tests/caps.test.ts`: add the tag to each list.
4. Add a row to the table under Use in `README.md`, and a short section under Styles. The GIF there and the architecture page in `docs/` are the maintainers' to add.
5. Try it: `claude --plugin-dir .`, then `/spinner <tag>`, then ask Claude something that takes a while.

The colours are yours to choose, for a dark background: a style need not share the palette of the others. Each frame costs Claude Code a redraw of the line. If you can, say in the pull request what the style costs; `bench/cpu.sh` measures it on macOS with kitty. This is not required.

## A terminal the README marks as not tested

Install the mod and, in that terminal, run `/spinner temper`, `/spinner holo` and `/spinner bloom`, asking Claude something after each. Then open an issue with:

- the terminal and its version, the operating system, and Claude Code's version;
- what `/spinner` replied for each style;
- a screenshot of the spinner line in each style while Claude works.

## Pull requests

- Run the commands under Development in `README.md`. They pass; name any that could not run on your machine, and why.
- Show the change running: a screenshot or a GIF from a real terminal, with the terminal's name and version. The tests cannot see a terminal, so only this shows what a person will see.
- One change to a pull request.
- A change that brings an icon takes it from an open icon set, recorded in `THIRD_PARTY.md`. Icons are not drawn by hand.

An agent that cannot open a terminal says so in the pull request and asks its person for the screenshot. A terminal imitated through environment variables is not that terminal.
