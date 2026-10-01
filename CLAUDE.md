# Working in this repo

## Push changes by default

After completing changes and the required local checks, **commit and push them
every time.** This is standing authorization; no separate push request or
confirmation is needed. Follow any explicit instruction to leave a particular
change unpushed.

## Never run the test suites here

They are Electron suites: each one boots a browser engine and several boot the
whole app, so a full pass ties this machine up for a long time. I run them in
the cloud.

Verify with `just typecheck` and `just build`, which catch what can be caught
locally. Write and update tests
as part of the work — just do not execute them, and say plainly in the summary
that they were written but not run.

## Branching

Straight to `main`. No feature branches; this is a solo project and the history
is all on one line.

## Handwritten release notes

`release-notes.md` supplies the in-app What's new popup. Its heading is
`# <package.json version>`, followed by Markdown feature bullets.
The maintainer must write every feature bullet by hand. Never generate,
rewrite, or fill in release bullets as an agent.

Whenever preparing or bumping a release, run `pnpm check:release-notes`.
If notes are missing, unfinished, or for a different version, explicitly tell
the user which version needs handwritten notes and link `release-notes.md`.
Continue authorized implementation and pushes; publishing requires valid notes.
