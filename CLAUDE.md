# Working in this repo

## Never push unless asked

Commit as much as you like. **Do not `git push` unless I have asked for it in
that message.** Not when the work looks finished, not when the tests pass, not
because the last thing I asked for was a push. Every push is a separate
instruction.

If you think something ought to go out, say so and stop.

## Never run the test suites here

They are Electron suites: each one boots a browser engine and several boot the
whole app, so a full pass ties this machine up for a long time. I run them in
the cloud.

Verify with `pnpm run typecheck` and `pnpm run build`, which are fast and catch
what can be caught locally. Write and update tests as part of the work — just
do not execute them, and say plainly in the summary that they were written but
not run.

## Branching

Straight to `main`. No feature branches; this is a solo project and the history
is all on one line.
