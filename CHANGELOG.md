# Changelog

[README](README.md) · [All documentation](README.md#documentation-table-of-contents)

## Contents

- [[Unreleased]](#unreleased)
- [[3.0.0] — 2026-10-19](#300--2026-10-19)
- [[2.9.0] — 2026-10-14](#290--2026-10-14)
- [[2.8.0] — 2026-10-09](#280--2026-10-09)
- [[2.7.0] — 2026-10-08](#270--2026-10-08)
- [[2.6.0] — 2026-10-02](#260--2026-10-02)
- [[2.5.1] — 2026-08-31](#251--2026-08-31)
- [[2.5.0] — 2026-08-30](#250--2026-08-30)
- [[2.4.0] — 2026-08-18](#240--2026-08-18)
- [[2.3.0] — 2026-08-18](#230--2026-08-18)
- [[2.2.1] — 2026-08-18](#221--2026-08-18)
- [[2.2.0] — 2026-08-17](#220--2026-08-17)
- [[2.1.1] — 2026-08-12](#211--2026-08-12)
- [[2.1.0] — 2026-08-12](#210--2026-08-12)
- [[2.0.0] — 2026-08-09](#200--2026-08-09)
- [[1.1.1] — 2026-05-20](#111--2026-05-20)

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A hold that waits on a person ends with that person.** `PAPERCLIP-OUTCOME:
  blocked on <Name>` hands the task to the named board user, still blocked, in
  the run's own write, as its assignee; the bot stays the unblock owner, since
  the board refuses an agent naming anyone else, and the unblock note names them. A name the board does
  not have keeps the task with the bot, blocked, and the comment says so.
- **Paperclip escalations are worked, and can be handed up a chain.** A blocked
  card assigned to the bot that carries one of `PAPERCLIP_ESCALATION_LABELS`
  (default `Needs EM ruling`) is worked instead of refused, and stays blocked:
  the wake's checkout is put back, and the run is told it is an escalation and
  what is its to decide (`PAPERCLIP_ESCALATION_AUTHORITY`). It resolves it, or
  ends `PAPERCLIP-OUTCOME: escalate` and the card is reassigned, inside its
  run, to `PAPERCLIP_ESCALATE_TO` (`agent:<seat>` or `user:<id>|Name`); a
  person is also pinged once in `PAPERCLIP_ESCALATION_CHANNEL` with
  `PAPERCLIP_ESCALATION_MENTION`. Each setting has a per-board key in
  `PAPERCLIP_EXTRA_BOARDS`. An escalation runs once per hand-off or comment;
  a re-wake on an unchanged card is left blocked and quiet.
- **A resolved escalation unwinds back down its chain, still blocked.** The
  chain is read from the card's assignment records since it last went
  blocked. A bot that resolves hands the card back, inside its run, to whoever
  handed it up — or to `PAPERCLIP_ESCALATION_RETURN_TO` (per board,
  `escalationReturnTo`), for the bottom bot that returns it to the seat that
  first raised it. A person resolves by commenting and reassigning down; the
  bot is told the card came back with a resolution. `PAPERCLIP-OUTCOME:
  blocked` keeps a card the bot can neither resolve nor escalate.

### Changed

- **A re-wake note never buries a held answer.** The note on an unchanged ask
  now repeats the answer's first line and who the task waits on, in place of
  "This was answered above. Add a comment with anything new". Earlier notes are
  no longer deleted: the board lists a deleted comment as a blank one, which
  read as the bot posting an empty reply. A blank answer is posted as the
  fallback reply, never empty.
- **Run environment.** `BOT_RUN_ENV` takes exact names only. A selected
  variable is hidden from Codex commands unless it has a non-credential name
  and its whole value is one absolute path. MCP command lines may expand only
  variables the run can read. Short withheld credentials, a `BOT_SETTINGS` env
  block on a board-running bot, and a cut shell policy now refuse startup.
- **Board decisions are read structurally.** A status, holder or waits change,
  by its credited writer, decides who holds a card, so no comment text does,
  and an interrupted escalation is not resumed over someone's newer decision.
- **The Paperclip poller re-reads the card before it acts.** It reads the card
  again before running the model and before every return, hand-on or unlink,
  resumes a wait only when every linked task reads done on a fresh read, and
  treats a hand-back as a new ask.

### Fixed

- A blocked answer on a card in a review stage no longer loops. The board takes
  the reviewer's write as changes requested, moves the card itself, and refuses
  the block's unblock note (HTTP 422); the same write was retried every tick.
  The answer now goes as a comment and the board's review keeps the status.
- A held card's note is no longer repeated on each of Paperclip's re-wakes of
  an unchanged card.

## [3.0.0] — 2026-10-19

### Changed

- **Breaking: which board wakes start the model is the operator's to set, and
  the defaults are quiet.** See [Model-work triggers](docs/model-work-triggers.md).
  - `PAPERCLIP_INTAKE` lists the card statuses a new ask starts the model in.
    The default is every status but `backlog`. A card outside the list gets one
    note, is put back in its status, and no model run. `all` keeps 2.x.
  - `PAPERCLIP_REWAKE` replaces the fixed limit of re-looks at an ask answered
    as waiting. The default is `off`: each such wake gets the mechanical note.
    `N` allows up to `N` looks, the last told to escalate. `4` keeps 2.x.
  - An unreadable value in either turns the board connector off.

### Added

- The effective trigger settings are logged at start, and each wake that does
  not start the model logs the setting that decided it. A wake that starts it
  logs why.

## [2.9.0] — 2026-10-14

### Added

- **A bot can listen on Paperclip alone, with Discord off.** Discord and
  Paperclip are peer surfaces, and `BOT_SURFACES` declares which a bot is on:
  unset, the configuration decides (#89): Discord when there is a
  `DISCORD_TOKEN`, plus any usable board it is given; `paperclip` declares the
  board alone. A bot with a board and no `DISCORD_TOKEN` is Paperclip-only
  without declaring it, and its connector must then come up or it exits 78. A
  declared surface is a prerequisite:
  `BOT_SURFACES=paperclip` without the Paperclip connector enabled (a board,
  and its connector on) exits 78, saying the Paperclip connector must be
  enabled first, and `doctor` / `doctor:fleet` fail it the same way. A bot with
  neither a `DISCORD_TOKEN` nor a usable board exits 78, naming both, rather
  than come up deaf and report ready. A Paperclip-only bot logs `Discord off — Paperclip-only` and
  never builds or logs in a Discord client; a scheduled job
  (which posts to a Discord channel) is refused when it is loaded, with a log
  line, and kept in its file; the background summarizer is off.
  Readiness is per surface: the ready marker is written once Discord is ready
  (if on) and each board's first poll has succeeded (if on), each board is
  polled once at startup rather than after the first interval, and
  `doctor:fleet` reports each surface (`Discord: off · board paperclip:
  ready`). A bot on both surfaces is now
  ready only once its board has answered a poll too.

- **One bot can answer on more than one Paperclip board.** `PAPERCLIP_EXTRA_BOARDS`
  lists the others as `{ id, url, keyEnv, promptChannel }`, so an agent seated
  in two companies is answered by the same bot, with each board's replies
  shaped by the channel whose audience matches its readers. Each board gets its
  own poller, state file and task sessions; the first board keeps its existing
  names, so nothing it answered is asked again. `keyEnv` names the variable
  holding that board's key, which is kept from Claude like `PAPERCLIP_API_KEY`.
  A broken entry is logged and skipped, and the same board listed twice is
  refused, since two pollers would race for its runs.

### Fixed

- **An answer owed by a run Paperclip cancelled waits for the task's next
  run.** When a person blocked a task and stopped the bot mid-run, Paperclip
  cancelled the run, and the bot retried the fallback under it every poll,
  refused each time (403 `agent_run_cancelled`, SLA-1337). A cancelled run is
  now never written under; the owed answer goes out under the task's next run.
- **A run Paperclip loses after a resume, or a replacement run it loses
  too, is recovered like any other.** The wake that resumes a task checks it
  out with no record, so the bot's earlier block used to outrank Paperclip's
  settlement of the run it then lost: the card stayed blocked with no note and
  no new run. A stop that was no one's choice no longer hides a newer one.
- **A change to what a task waits on never reruns an answered ask.** An ask
  used to be saved under a key that also named the finished waits it came back
  from, so any later change to the waits gave it a new key and ran it again.
  The key is now the ask alone. A blocked answer records the wait it is in, as
  the run that wrote it, at the moment it is written; the ask resumes from that
  wait once, when its tasks are done or someone moves the card on, and the
  resume's own answer ends it. An answer that is not blocked is final. State
  saved under the old keys reads back as the asks they name.
  A saved answer whose post is retried is found delivered only in a comment
  made after its attempt started, so the same words from the wait before are
  not taken for it. Asks posted together each keep their own outcome: an
  older ask finished but never posted used to take a newer ask's blocked
  status, and ran again when that wait was done. A blocked answer that was
  posted as a comment only stopped nothing, so it resumes on its waits or a
  move made after it, not on a card left open. Going on at once with work
  whose waits were already done is an attempt like any other: a bot that dies
  in it runs it once more, told so, when allowed, or posts the fallback —
  it used to post the earlier answer and leave the card blocked on nothing.
- **A person who blocks a task just as the bot closes it blocked keeps the
  hold.** The close lands as the same status reasserted, and used to count as
  the bot's own block, so the task resumed when its wait finished. The hold
  now stays the person's; their waits are put back, and their note, which
  Paperclip lets no agent write back, is quoted in a comment.
- **No bot write overwrites a person's newer change to a task.** Every status
  or blocker write the bot makes — a close, a hold put back, a follow-up —
  now reads the task's record first. If a person changed its status or what
  it waits on after the board the bot decided from, their version stands and
  the bot comments instead. A person who re-blocked a task on something new
  while the bot was putting back their earlier hold used to get the old waits
  back; a person who moved a card on while the bot answered, or as it closed,
  had it closed done over them. The record is read before the task, and the
  check made after the close's waits are looked up, so a change between the
  reads or during the lookups is seen; a change to what the task waits on
  that lands as it closes is put back after. A wake on an ask already answered
  closes it as that answer left it, decided from the board as the answer was:
  a person who moved the card to review while the bot answered used to have
  it closed done by the next wake. An ask answered blocked keeps its card
  blocked through those wakes — Paperclip's checkout used to leave it in
  progress, where the finished part of its wait was never cut from the card. If
  the last of its waits finishes during that wake, nothing is written and the
  ask resumes on the next poll. A move a person makes on a blocked card counts
  from the blocked answer itself, so a note the bot posts after it no longer
  hides the move and the ask still resumes. A wait is looked up once per post: a
  task that reopened between two looks used to leave the card blocked on
  nothing. The board the bot decides from also keeps the entries it saw at its
  newest time, so a person's change recorded in that same millisecond counts
  as newer and stands — and so does every write the bot makes after one of its
  own, a hold put back or a status restored, judged from the board as that
  write was recorded. A blocked ask resumes when the card is reopened after the
  answer itself, even in its millisecond, never after a note the bot posted
  since.
- **An answer whose post failed is still posted when a person stops the card
  with a comment.** The comment is a newer ask, and a stopped card takes no
  new work: the retry used to post only the "stopped by someone else" note,
  and the answer already made was never delivered. It goes out now as a
  comment only, and the card stays as the person set it.
- **A card the Foreman blocks and hands to the bot is worked.** The Foreman's
  sync writes with a board user's key, so its escalation (blocked, assigned to
  the EM) read as a person's stop: the bot posted the "stopped by someone else"
  note on each wake and Paperclip escalated the retries. On a mirrored card, a
  stop whose write also assigns the card to the bot is now that hand-off; a
  person's stop that does not hand it over still holds.
- **A board run never keeps a Discord or bridge credential under another
  name.** Bots started from one shared environment hold every bot's token
  under its own name (`EM_DISCORD_TOKEN`, `PO_DISCORD_TOKEN`, `DISCORD_BOT_KEY`…);
  every board run, parity included, now withholds any variable named as one,
  and any variable carrying one's value.
- **A parity board run's commands get no Paperclip key under another name.**
  The same shared environment holds every bot's board keys, the board sync's
  admin key among them; a parity run now withholds each, and any variable
  carrying one's value. The connector's own key still reaches a Codex MCP
  server that names it.
- **A run Paperclip gave up on takes no new ask.** When a newer ask came in
  after the attempt a gone run still owes, that attempt is posted as a comment
  only, and the newer ask waits for a live run of its own.
- **A mirrored task answered blocked is not run again on every wake.** Its card
  never moves for the answer, so only a status move recorded after the answer
  brings the ask back.
- **A wait that finishes while the bot answers does not turn the ask into a new
  one.** The answer still closes the card, and the wake for the finished wait
  finds the ask answered rather than running it again.
- **Paperclip settling a lost run does not lift a person's hold.** On a task
  already stopped, its blocked settlement is not a decision of its own: the
  earlier stop stands, a person's included, for own and mirrored tasks.
- **An answered blocked ask is not run again when a close clears done links.**
  The same unchanged ask, keyed without the suffix those links gave it, is
  still the ask already answered, across a restart too.
- **A board session made under other access is not resumed.** Each stored board
  session records the access it was made with (run kind, board policy,
  permission mode, the bot's settings, and its tools, allow and deny rules);
  after any change the next ask starts fresh, on both runtimes.
- **A Codex session's MCP servers keep the Paperclip keys their config names.**
  The connector keys (`PAPERCLIP_API_KEY` and each extra board's) were removed
  after the servers' environment was set, so a server that named one ran
  without it. They now reach that server, in Discord and parity board runs,
  and are still excluded from every command the model runs.
- **Credential files under the folders the bot's settings open to reading are
  denied to a board run**, as those under the working directory already were.
- **A blocked answer is never left waiting on tasks already done.** When the last
  task it named finishes just before the block is posted, or before a saved
  answer's post is retried, nothing is written: the work goes on once, told what
  the answer said so nothing done is done again, and the card closes from the
  result. A person's stop still holds it.
- **A person's stop holds a mirrored task too.** A task another writer owns is
  no longer worked after a person blocks or cancels it; a block its own writer
  sets for the bot to clear is still worked.
- **A parity board run's MCP servers never put back the Discord credentials.**
  A Codex server env entry naming a withheld variable, or carrying its value
  under another name, is left out of that run.
- **A Paperclip card stays true after handoffs, lost runs and restarts.** A
  task that waits on others is blocked by exactly the tasks it names, its wait
  is trimmed as each one finishes, and when the last is done the same card
  resumes, says which task it waited on, and closes done under the run it came
  on; a task blocked on work that is already done goes on at once. A run the
  board lost keeps working: the card gets a note, the bot opens a new run on
  it, and the one answer closes it there, with no second launch. A blocked
  answer is not taken as finished — a person moving the card on asks it
  again — and the newest answer decides the card's status. A person's blocked
  or cancelled stands — the bot writes no status over it, does not resume or
  rerun a task a person holds, and a mirrored card gets only the answer as a
  comment. Paperclip takes nothing under a run a person cancelled, so that
  answer waits for the task's next run.
- **Board runs cannot read secret files the scan did not reach.** Folders past
  the scan's budget (`node_modules` is scanned last) are denied rather than
  left readable.
- **Codex MCP servers from two configs no longer overwrite each other's
  keys.** A server whose variable another already set differently is skipped.
- **A restricted Codex run's commands cannot read the bot's keys.** Board
  runs, summaries and restricted sessions run commands with only the core
  environment (HOME, PATH, USER…), so `MCP_CONFIG` or `DATABASE_URL` cannot be
  printed into a reply.

## [2.8.0] — 2026-10-09

### Added

- **`doctor:fleet` checks each bot's Paperclip board.** For a bot that sets
  `PAPERCLIP_URL` and `PAPERCLIP_API_KEY`, it signs in to the board with the key
  and names the agent it gets back, fails a key the board rejects, and fails a
  `CLAUDE_CWD` the connector would refuse at startup (the harness or the bot's
  state folder, or inside one). Half a board config warns that the connector is
  off. Before this, a revoked key showed only as a board task failing 20 minutes
  later. The key is read from the environment by name and never printed.

### Fixed

- **`doctor`'s dead-settings check flagged working settings.** It read only the
  harness's own source, so the switches read by the skill pack's hooks and commands
  (`BOT_MAIL_*`, `BOT_CALENDAR_NO_ATTENDEES`, `BOT_LAND_PATHS`), the variables a
  bot's `.mcp.json` interpolates, and git's and gh's own (`GIT_*`, `GH_*`) were
  all recommended for deletion. It now reads the skill pack and the names in each
  bot's `.mcp.json`, and leaves `GIT_*`, `GH_*` and `GITHUB_TOKEN` to those tools.

## [2.7.0] — 2026-10-08

### Security

- **`restricted` now restricts MCP tools too.** `--tools` limits only the built-in
  tools: every MCP server on the host stayed exposed, and a user-level
  `defaultMode: bypassPermissions` ran each tool unasked. Measured 2026-10-08, a
  restricted session could reach a shell-running MCP server and Klaviyo's send and
  write tools. Restricted sessions (and the summarizer) now run in `dontAsk` mode,
  which denies anything not pre-approved. `BOT_PERMISSION_ALLOW` is the
  pre-approval list. `dontAsk` would honor an approval from any settings file, so a
  restricted session reads none: only `BOT_SETTINGS` applies, and CLAUDE.md still
  loads. **Upgrading:** a restricted bot that relied on MCP tools must name them in
  `BOT_PERMISSION_ALLOW`; hooks, deny rules or approvals it took from a user or
  repo settings file move into `BOT_SETTINGS`, `BOT_PERMISSION_ALLOW` or
  `BOT_PERMISSION_DENY`. A restricted bot can always read its own
  uploads folder (`BOT_ATTACHMENTS_DIR`) without a rule, so files people send it
  stay readable. `bypass` sessions are unchanged.
- **Summaries run narrow in every mode.** Buffer-rotation, hourly and
  `npm run summarize` summaries read chat text from anyone in the channel, yet under
  `bypass` they ran with every tool and the skip flags, outside `BOT_SETTINGS`. They
  now always get only `BOT_SUMMARIZER_TOOLS` (default `Read`), `dontAsk`, no MCP
  servers, plus `BOT_PERMISSION_DENY` and `BOT_SETTINGS`. A summary needs no tools,
  so nothing it writes changes.
- **Mail gate.** A permission rule sees a tool's name, never its arguments, so
  allowing Gmail's `send_message` allowed mail to anyone. With
  `BOT_MAIL_ALLOWED_RECIPIENTS` set, the skill pack's `PreToolUse` gate requires
  every `to`/`cc`/`bcc` address to be on the list, refuses draft sends, replies and
  unknown arguments, and enforces `BOT_MAIL_SUBJECT_PREFIX` when set. It fails
  closed. Bots that set neither variable are untouched.
- **Calendar gate.** With `BOT_CALENDAR_NO_ATTENDEES` set, a bot's calendar writes
  invite nobody: attendees on create, added attendees on update, any calendar but
  `primary`, unknown arguments, and an update or delete without
  `notificationLevel: "NONE"` are refused. It fails closed. Bots without the
  setting are untouched.

### Added

- **`MCP_CONFIG_STRICT=true`** loads only the servers in `MCP_CONFIG`
  (`--strict-mcp-config`), so a bot cannot see the host's other MCP servers. With
  `MCP_CONFIG` unset it keeps the repo's own `.mcp.json` in `CLAUDE_CWD`.
- **`MCP_CONFIG_EXTRA`** — a second `--mcp-config` (a path or inline JSON) that
  strict mode still honours, so a bot can keep strict on and name the one
  claude.ai connector it needs as a `claudeai-proxy` server.
- **`BOT_PERMISSION_DENY`** maps to `--disallowedTools` (deny beats allow), so a
  restricted bot can be pre-approved a command but stopped from aiming it
  elsewhere — e.g. allowed on its own board, denied any `--repo`, `-R` or URL
  naming another repo.
- **`REPLY_FINAL_TEXT_ONLY=true`** posts only the text written after the last tool
  call, so a working note written before a tool call never reaches the channel.
  Off by default; every bot that does not set it replies exactly as before.
- **`land` — a restricted bot commits and pushes only the files it names.** A raw
  `git commit`/`push` allow rule sees only the command's prefix, so it would let a
  bot commit anyone's uncommitted edits or publish unpushed local commits. The
  skill pack's `land` command is the bot's only way to commit: `BOT_LAND_PATHS`
  (globs, `!` excludes) names what may land, unset means landing is off. Every
  concrete file git would commit is checked, so naming a folder cannot carry an
  excluded file out with it, and a wildcard is a literal name. It
  refuses a checkout with unpushed commits and builds the commit outside the
  checkout, from the upstream tip plus the checked files, then pushes it by id: a
  commit another session makes meanwhile is never published or undone, no local
  commit hook can add to it, and a rejected push leaves nothing behind.
- **`BOT_SETTINGS`** layers Claude Code settings (a path or inline JSON) over every
  session through `--settings` — e.g. a sandbox around the shell.
- **`BOT_PERMISSION_DENY` now also applies in `bypass` mode.** Nothing prompts, but
  a denied tool or path stays denied. Unset, the bypass argv is unchanged.
- **Paperclip connector.** Opt-in with `PAPERCLIP_URL` and `PAPERCLIP_API_KEY`: the
  bot polls its Paperclip inbox, answers each open task through the same run path
  as Discord, and posts the reply under the run. A board run gets least privilege
  in every mode, `bypass` included: `BOT_BOARD_TOOLS` (read-only built-ins by
  default) in `dontAsk`, confined to the working directory, plus whatever
  `BOT_BOARD_PERMISSION_ALLOW` names. Board runs get one session per task, never see the Discord buffer, and
  the key is scrubbed from Claude's environment. Nor can a board run reach Discord
  memory any other way: the memory stores (buffer, summaries, uploads, sessions,
  scheduled jobs) are left out of its environment, so recall reports them
  unavailable, each path — and the state folder and outbox of files already
  sent — carries a read deny rule, and any shell a board run is
  allowed runs in Claude Code's sandbox confined to the working directory and
  the system folders (no stepping outside it; a host without the sandbox fails
  the run rather than running it open). Claude Code's project auto-memory,
  shared with the Discord sessions in the same folder, is off for a board run,
  and no settings file is read for one: an approval made for Discord sessions
  (in `BOT_SETTINGS`, the repo's or the user's settings) does not carry over.
  A board run's environment carries none of the bot's own configuration (every
  `BOT_*` variable but the few the skill pack's hooks read, `MCP_CONFIG*`, the
  Paperclip key, the Discord and bridge tokens), so a credential inside an inline
  `BOT_SETTINGS` cannot be printed into a reply. Withheld as well is
  the whole harness folder (its `.env`, logs and default state): a bot whose
  `CLAUDE_CWD` is the harness or state folder (or inside one) keeps the connector
  off and logs why, since the sandbox always opens its working directory. An answer whose post fails is
  kept (across a restart) and re-posted; the task is never run twice. A comment
  that lands while the bot is answering keeps the task open, so it is answered next;
  a re-wake of an answered task gets a short note under its run, never a second run.
  A file the run makes is named in the reply as not delivered, since a board
  comment cannot carry one.
  A board task
  cannot book a follow-up: `schedule.mjs` refuses any destination that is not a
  Discord channel, rather than saving a job that would never fire.

### Fixed

- **The background-job gate prints the bot's bridge port.** A job launched outside
  the bot's env (systemd-run, cron) has no `WS_PORT`, so `signal.mjs` defaulted to
  9800 and missed a bot on another port. The gate now prints `--port` explicitly.

## [2.6.0] — 2026-10-02

### Added

- **A background job can call the bot back — and a bot can no longer lose one.**
  Each Discord reply is one `claude -p` process, so a Bash call with
  `run_in_background` was killed the moment the reply was sent, and any "I'll post
  here when it finishes" went with it. The skill pack now ships a `PreToolUse` hook
  that blocks that call under the harness and prints the path that works: book a
  follow-up with `--wait-for <name>`, detach the job, and make its last step
  `scripts/signal.mjs <name>`. The bot wakes the moment the job ends — the Claude
  Code terminal's task notification, over Discord. It ships in the plugin, so every
  bot gets it with no per-repo setup.
- **Per-channel system prompt.** `.claude/channel-prompts/<channel-id>.md` in
  `CLAUDE_CWD` layers over the repo-level overrides, so one bot can address
  different audiences in different channels without sharing one set of instructions.
- **Silence and scheduling rules in the always-appended prompt.** A scheduled check
  that finds nothing now sends nothing — not a status line about having nothing to
  say — and a promise to check back must be booked with the scheduler, never a sleep.
  These ride with the medium, so a custom `BOT_SYSTEM_PROMPT` keeps them.

### Fixed

- **`signal.mjs` reported a delivered signal as a failure.** The bridge acknowledged a
  signal only after the follow-up it woke had finished its whole Claude run, so the
  sender's 5-second wait printed *"No answer from the bot … is it running?"* about a
  signal that had landed. A deploy step under `set -e` would fail on success. The
  ack now goes out as soon as the follow-up is claimed.
- **Summaries: only a dated file is loaded as one.** Any `.md` in the history dir
  whose name began with a letter sorted after today's date and was injected
  unconditionally, crowding out the real summaries under the argv budget.
- **`npm run doctor` on a multi-bot host.** Single-bot checks read the ambient env
  that a per-bot `ecosystem.config.js` never sets, and reported FAIL on a healthy
  host. They now report SKIP there.
- **`ecosystem.config.example.js` sets a 45-minute per-request ceiling**, up from 20,
  which killed long-but-healthy turns with exit 143.

## [2.5.1] — 2026-08-31

### Fixed

- **The `signal --data` example in the README dropped its payload.** Written as
  `npm run signal ci:build --data "..."`, npm eats the flag NAME and forwards only its
  value as a bare positional, so `scripts/signal.mjs` — which reads `--data` off
  `process.argv` — received the signal name and nothing else. The signal fired; the
  evidence it was supposed to carry silently did not. No error, no warning, exit 0.

  The separator is required: `npm run signal ci:build -- --data "..."`. The README
  already used the correct form for `--port` twenty lines further down, so this was the
  one example out of step with the rest of the file.

  Reported by @webbrain-one. Docs only — no harness behaviour changed.

## [2.5.0] — 2026-08-30

### Added

- **Follow-ups a bot can actually keep.** The scheduler could only answer "every day at
  7". "I'll check back in twenty minutes" had to be translated into a wall-clock cron
  minute plus a matching `expires` — and an expiry landing one tick early DELETED the job
  before it fired, so the promise evaporated with no error anywhere. The alternative was a
  background sleep, which dies when the reply is sent.

  A wake job carries an instant instead of a cron: `wake --in 20m`, no clock arithmetic
  and no timezone to get wrong. It can CARRY the conversation that set it, because a
  follow-up with no memory of what it was following up on is a stranger asking a question
  — bounded by `BOT_WAKE_CARRY_MAX_MS` (default: the session idle timeout), since an
  unbounded chain of carried looks is the 2.2.1 incident wearing a different hat. When
  carry expires the run is TOLD, so it works from its note rather than referring to what
  it cannot see.

  It does not recur. The run decides whether to look again and how long to wait, so a slow
  deploy is checked patiently and a nearly-done one closely; its prompt carries the exact
  re-arm command, pre-filled. `BOT_MAX_WAKE_ATTEMPTS` (default 12) and an optional
  deadline are backstops, not the plan. A wake is claimed before it runs, so it fires **at
  most once** — the same guarantee the resume path already makes, for the same reason:
  these prompts merge PRs.

- **Signals — tell a bot the thing it was waiting for happened.** A follow-up can name a
  signal alongside its time: wake when `dev-deploy-done` fires, or in 30 minutes,
  whichever comes first. Anything that can run a command fires one —
  `npm run signal dev-deploy-done` at the end of a deploy script, a CI job, a git hook.

  A sender passes a **name, never a prompt**. The words that run were written by the bot
  in the conversation where it promised to look, and a signal can only release a follow-up
  that bot already booked, in the channel it already chose — so this is safe to hand to a
  CI job. Attached text arrives fenced and labelled untrusted: evidence to read, never
  orders to follow. Names are opaque to the harness; there are no built-in integrations to
  configure and nothing to register.

  **The timeout is still there.** A signal that never arrives costs nothing — the
  follow-up fires exactly when it always would have — so nobody can depend on a notifier
  they have not wired up. Signals are the one bridge message gated by a credential,
  because they start a run rather than posting text: loopback is trusted as it always has
  been, and a bridge bound anywhere else must set `BRIDGE_TOKEN`. The handshake now
  advertises its capabilities, so a notifier can tell an older harness from a silent drop.
  A signal arriving seconds BEFORE its follow-up is booked is remembered for
  `BRIDGE_SIGNAL_MEMORY_MS` (bounded, consumed on use).

- **Repo-level system-prompt overrides.** Instructions that must beat the harness defaults
  they contradict, read from `.claude/system-prompt-overrides.md` in the repo each bot
  serves. They ride at the HEAD of the system prompt, never the tail, because an oversized
  argument is truncated from the end — anything appended last is exactly what a clamp
  eats, and a silently dropped override is worse than no override. A repo without the file
  is unaffected; a read error warns and continues rather than taking the bot down for a
  missing optional file. Each load is logged, because "the overrides are live" should not
  have to be argued from the file merely existing.

### Fixed

- **A dropped bridge message now names the channel it was dropped for.** Every bridge send
  resolved its destination with `channels.cache.get()` inside a bare `if (channel)`. A
  channel the bot cannot access is simply absent from that cache, so the message was
  discarded on an else branch that did not exist. The Foreman published status for hours
  while the logs stayed clean and a missing permission looked like a cache bug. Sends now
  fall back to a fetch — which also covers the moment after a gateway reconnect when the
  cache is briefly empty — and say so loudly when even that fails.

- **A scheduler tick no longer saves a stale copy of the schedules file.** A run can create
  a job while it is running — that is how a watch re-arms itself — and the tick's
  in-memory array predates that write. Every write inside a tick now re-reads the file
  first, so a follow-up the run just scheduled is not silently deleted by the tick that
  fired it.

## [2.4.0] — 2026-08-18

### Added

- **`npm run advise` — an upgrade advisor that runs BEFORE you upgrade.** `doctor` answers
  "is this install healthy right now". This answers "what will break when I upgrade, and
  what do I do about it", as an ordered list of concrete actions rather than observations
  to interpret.

  It is built to run against an install that has **not** upgraded yet, which is the only
  time the answer is useful. It imports nothing from the rest of the harness, evaluates
  nothing, and starts no bot — so `--dir` can point at a checkout several majors behind,
  from a current clone or as a single copied file.

  Findings are gated on the version actually installed *there*, so a 1.x install is told
  its tool exposure will flip to `restricted`, while a 2.2.1 install is not. The same
  tight schedule is a blocker before 2.2.1 and a warning after it, because after 2.2.1 it
  no longer accumulates context — it can still overlap its own previous run.

  What it reports: tool exposure flipping on upgrade, schedules tighter than the session
  timeout, where each bot's `schedules.json` actually resolves to (the backup target,
  which is not obvious), tokens that need verifying, missing `stop_exit_codes`,
  `ANTHROPIC_API_KEY` redirecting billing, uncommitted work and unpushed commits an
  upgrade would discard, bots running code that is no longer on disk, and sibling
  checkouts holding runtime state.

  `--json` emits a stable schema for an agent: every entry has an id, a severity, the
  reason, a concrete action and structured evidence, sorted blockers first. Exits non-zero
  when there are blockers so it drops into a script. No credential value is ever printed —
  tokens are named by the variable they come from.

## [2.3.0] — 2026-08-18

### Added

- **Upgrade-readiness checks in `npm run doctor`.** The guide could tell you what changed
  in a release; nothing could tell you what was going to break on *your* host when you
  restarted. Three checks now answer that:
  - **Scheduled jobs** — flags any job firing faster than `SESSION_TIMEOUT_MS`. On 2.2.0
    and earlier that job pins its channel's session open permanently (the bug fixed in
    2.2.1); on any version it means a job can overlap its own previous run.
  - **Running code** — flags a connected bot that started before `bot.js` was last
    changed. The working tree is the deployment and Node reads the file once at startup,
    so a fleet restarted at different times runs different code with nothing to say so.
  - **Claude billing** — flags `ANTHROPIC_API_KEY` in the environment, which silently
    bills spawned Claude runs as metered API usage instead of the subscription.

- **`npm run doctor:fleet`** — checks every bot in `ecosystem.config.js` in one pass:
  token verified against Discord, `CLAUDE_CWD`, permission mode resolvable, schedules and
  running code. `doctor` previously validated only whichever bot's configuration was in
  the ambient environment, so an 8-bot host needed 8 runs with 8 environments — which is
  the same as not running it. Plain `doctor` now points at it when it sees more than one
  bot configured. No secret value is printed; a token is confirmed by the bot name that
  comes back.

### Fixed

- **`doctor` no longer recommends deleting working configuration.** Its "dead settings"
  check scanned only top-level source files, so a setting resolved inside `lib/` read as
  configured-but-unread — including `BOT_PERMISSION_MODE`, which every bot depends on. It
  now scans `lib/` and recognises settings read through a shared resolver.

## [2.2.1] — 2026-08-18

### Fixed

- **A scheduled job no longer runs inside the channel's conversation session.** A job
  on a 10-minute cron held ONE session open for 28.8 hours across 2,115 turns. Every
  fire re-sent the whole accumulated history, so a poll that correctly found nothing
  still paid for ~400k tokens; context reached 998k and that single session cost
  ~$1,664 in a day.

  The cause is that sessions are keyed by CHANNEL and expire on 30 minutes of **idle**.
  A job firing faster than `SESSION_TIMEOUT_MS` means its channel is never idle, so
  rotation never fires — the safety net cannot catch a cadence shorter than its own
  timeout, and nothing warns, because a busy channel is what a healthy channel looks
  like.

  Second defect in the same place: the job and any human talking in that channel
  shared one session, so the poller inherited conversation context and the
  conversation inherited hundreds of prior polls.

  Scheduled runs are now **ephemeral** — they resume nothing and store nothing. A job
  is a task, not a conversation; it has nothing to carry forward, and remembered
  context is still injected as it always was.

  Deliberately not applied globally: a human message and a reaction trigger still
  resume the channel session, because a conversation that resumes nothing loses the
  continuity the session exists for.

## [2.2.0] — 2026-08-17

### Added

- **`BOT_PERMISSION_MODE_DEFAULT`** — a host-wide default for the tool-permission
  mode. `BOT_PERMISSION_MODE` was per-bot and nothing else, so a host running eight
  bots needed the same line eight times, and missing one failed silently: that bot
  kept answering questions and had quietly lost the ability to write a file.
  Resolution is per-bot, then host default, then `restricted`. Opt-in and additive —
  set neither variable and the answer is `restricted`, exactly as before.

  The startup log now names which of the three the value came from. On a multi-bot
  host the question is never "what mode is this bot in" but "why is this one
  different from its siblings", and an explicit `restricted` and an unset one were
  indistinguishable.

### Fixed

- **A dead token no longer restart-loops forever.** A failed login has exited
  non-zero since 2.0, which was the right fix for a bot that used to linger and
  report itself healthy. Under a process manager it created a new failure: a
  rejected token is the same token next time, so the bot restarted endlessly and its
  log drowned every sibling that was healthy.

  Failures a restart cannot cure now exit **78** (`EX_CONFIG`) — a rejected token, a
  missing `DISCORD_TOKEN`, a `CLAUDE_CWD` that does not exist, an unrecognised
  permission mode, an invalid `BOT_TIMEZONE`, `BOT_REQUIRE_ALLOWLIST=true` with an
  empty allowlist. Everything else keeps exit 1 and stays restartable, because a
  network blip does deserve another go, and a duplicate-instance guard is transient.
  `docs/INSTALL.md` shows the PM2 and systemd settings that act on it.

- **A scheduled job with nothing to report posts nothing.** The model cannot emit a
  truly empty turn — the harness re-prompts it — so a polling job whose answer was
  "nothing happened" reached for a placeholder (`[no output]`, `.`) and every one
  became a Discord ping. Suppressed at the send boundary, where the decision is
  deterministic. Scheduled jobs only; an interactive reply is never filtered.

- **`summarize.js` resolves the permission mode through shared code.** It read the
  environment variable directly, so a host-level default would have been honoured in
  the bot and ignored in the summarizer — the same drift documented at the top of
  `lib/summarize-core.js`, where adding this setting once needed three identical
  edits.

## [2.1.1] — 2026-08-12

### Security

- **Five advisories cleared — three rated high.** `npm audit` now reports zero.
  Two were in direct dependencies: **`ws`** 8.20.0 → 8.21.3 (uninitialized memory
  disclosure, and memory exhaustion from tiny fragments — this is the WebSocket
  bridge bots use to talk to each other) and **`discord.js`** 14.25.1 → 14.27.0.
  Upgrading those cleared the three underneath: `lodash` 4.17.23 → 4.18.1,
  `undici` 6.21.3 → 6.28.0, `@discordjs/rest` 2.6.0 → 2.6.3.

  Every fix fell inside the version ranges already declared, so `package.json` is
  unchanged and this is a lockfile-only upgrade — nothing for an installer to do
  beyond `npm install`.

  Thanks to **@anupamme**, who reported the lodash vulnerability in #47. The
  report was right; the pin was not — npm marks lodash 4.18.0 a bad release, and
  4.18.1 is the clean one. Upgrading `discord.js` pulls it in transitively, which
  fixes the cause rather than pinning around it.

## [2.1.0] — 2026-08-12

### Fixed

- **`Error: spawn E2BIG` on the first message after a restart.** A fresh session
  carried every daily summary in the lookback window plus the whole conversation
  buffer in one `--append-system-prompt` argument. Linux caps a *single* argv
  string at 128KB — separately from the much larger total `ARG_MAX` — and while
  the buffer had `BUFFER_MAX_BYTES`, summaries had no ceiling in the code or the
  config. Two busy days measured 137,242 bytes against a limit of 131,071, and
  every fresh session died at spawn with an error naming neither the cause nor a
  setting. It read as a reboot fault because a *resumed* session skips context
  injection entirely; in truth any conversation idle longer than
  `SESSION_TIMEOUT_MS` would have hit it.

  The summarizer had the same exposure — it hands a `SUMMARIZE_BATCH_SIZE`
  transcript through argv — where a crossing would have taken down the daily
  summary that recall depends on.

- **A user's schedules no longer live in a git working tree.** `schedules.json`,
  the job run log and the summarizer's read position moved from `BOT_HISTORY_DIR`
  to `BOT_STATE_DIR`, alongside the buffer and sessions. They were gitignored,
  which is not safe — only invisible: one `git clean -x` or a re-clone and the
  user's scheduled jobs are gone, and a schedule that silently stops firing is a
  failure nobody notices. `BOT_HISTORY_DIR` holds summaries, the reviewable record
  people deliberately keep in a repo; runtime state is not that. **Existing files
  are migrated on first start**, not stranded, and `summarize.js` resolves the
  checkpoint the same way — when those two disagreed, the summarizer re-read from
  the wrong position.

### Added

- **`CONTEXT_MAX_BYTES`** (default `65536`) — a declared ceiling on remembered
  context. Over budget, the oldest summaries are dropped and the prompt states
  that they were, pointing at `$BOT_SUMMARIES_DIR`, so a bot never reports that
  nothing happened on a day it merely was not shown. `/remember` still reaches
  every summary on disk. Independently, no argument now leaves the harness above
  the OS limit whatever the configuration says, so this failure is unreachable
  rather than merely unlikely.

## [2.0.0] — 2026-08-09

First release aimed at people who are not us. See [UPGRADING.md](UPGRADING.md) —
the upgrade is one line.

### Added

- **`npm run setup`** — interactive configuration that validates every answer
  live and writes a working `.env`. Catches Message Content Intent being off,
  which otherwise produces a bot that connects and then ignores every message.
- **`npm run doctor`** — the same checks, non-interactive, exits non-zero. For CI,
  container entrypoints, and bug reports. Prints no secrets.
- **`BOT_PERMISSION_MODE`** — `restricted` (default) or `bypass`.
- **`BOT_REQUIRE_ALLOWLIST`** — refuse to start with an empty `ALLOWED_USERS`.
- **`BOT_TIMEZONE`** — the bot's clock, validated at startup.
- **Live progress.** While a request runs the bot posts one status line, edited in
  place as it works, removed when the answer arrives. It reports activity only —
  the reply is still delivered once, at the end, unsplit — which is what lets
  progress return without reviving the "bot answered twice" bug that removed
  streaming in the first place (3c79e5e, 2026-03-28). Tool inputs are never shown.
  Disable with `BOT_PROGRESS_ENABLED=false`.
- **`/slashbin-harness:remember`** — recall across every store a bot has: all daily
  summaries (not just the injected window), the conversation buffer, attachments,
  live sessions and scheduled runs. Reports which sources it actually searched, so
  a missing store is never mistaken for an empty one. Works on resumed sessions.
- **Harness skill pack** — skills ship with the harness in `skill-pack/` and load
  into every bot, namespaced `slashbin-harness:<name>`, instead of being copied
  into each bot's repo where they hardcode paths and rot.
- **Scheduled jobs can be created from chat.** "Every weekday at 7am, post the
  standup" now works. The scheduler has always RUN jobs; nothing could create
  one — `schedules.json` had to be hand-written on the host, and the bot was never
  told the file existed. `/slashbin-harness:schedule` handles create, list, remove
  and run history, and reads a created job back to report the interpreted schedule
  and next fire time — a cron accepted silently is one nobody notices is wrong
  until it fails to fire.
- `BOT_MAX_SCHEDULED_JOBS` caps jobs per bot.
- **`npm run list`** — every bot instance this checkout has state for.
- Settings for previously frozen constants: `BOT_SCHEDULE_CHECK_MS`,
  `BOT_SCHEDULE_LOOKBACK_MINUTES`, `BOT_OUTBOX_MTIME_TOLERANCE_MS`,
  `BOT_BOT_EXCHANGE_PRUNE_MS`, `WS_HEARTBEAT_MS`, `WS_HEARTBEAT_MAX_MISSES`,
  `BUFFER_ROTATE_PERCENT`, `WS_HOST`. Every default unchanged.
- MIT `LICENSE` — the repository previously had none, which made it
  all-rights-reserved by default.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates.
- CI on Node 18 and 20, including a gate that fails if the example config names a
  setting the code does not read or stores a literal credential.
- `test/startup-safety.test.js` — 21 assertions covering startup, permissions,
  configuration, and the process manager.

### Changed

- **BREAKING: tool exposure is restricted by default.** Set
  `BOT_PERMISSION_MODE=bypass` for the previous behaviour.
- `npm run status` distinguishes *connected to Discord* from *process alive*.
- The process manager scopes pid and log files by `BOT_NAME`, so several bots can
  be managed from one checkout. Single-bot filenames are unchanged.
- The process manager loads dotenv config, so it can no longer disagree with
  `bot.js` about which instance it is managing.
- An empty `ALLOWED_USERS` warns loudly on every start.
- Numeric settings that are not numbers, or below their minimum, fall back to the
  default **and log it**, instead of being silently swallowed.
- `package.json` carries real metadata; the package is named after the repository.

### Fixed

- **A bot command sharing a name with a harness command is no longer invisible.**
  The harness intercepts `/fresh`, `/status` and the stop words before Claude sees
  the message, so a same-named command in a bot's own repo could never run — while
  still appearing in that bot's list of what it can do, because from inside Claude
  the command is real. Nothing errored, nothing logged. Found live: the PO bot
  advertised a `/status` that had never once executed. Now warned at startup,
  failed by `doctor`, and the reserved names are injected into every session so a
  bot can finally answer "what commands can I use here" correctly.
- **Cron fired in the host's timezone, not `BOT_TIMEZONE`.** A bot configured for
  London running `0 7 * * *` on a Chicago host fired at 7am Chicago — 1pm London.
  "Every morning at 7am local" meant "7am wherever the server is". Jobs now record
  the zone they were created under so a config move cannot silently reinterpret
  them, and the already-ran key is computed in the same zone as the match — they
  could otherwise disagree across a DST boundary and double or drop a run.
- **A cron range (`1-5`) was accepted and silently wrong.** The matcher understands
  `*` and comma lists only, so `1-5` parsed as `1` and a "weekdays" job fired on
  Mondays alone. Ranges and steps are now rejected with a message naming the fix.
- **Asking a bot to stop no longer answers with an error.** The stop path killed
  the run without marking the kill intentional, so the close handler treated it as
  a crash and replied `Error: Claude exited with code 143`. The bare `stop` form
  never sent "Stopped." at all — that error was its only feedback. Stopping now
  acknowledges whenever it actually stopped something, however it was phrased.
- **`stop x, y, z` now stops.** The matcher required an exact `stop` / `/stop`, so
  anything with trailing words fell through to Claude and *started a new run* — the
  opposite of the intent, at the moment you least want it. A message opening with
  `stop` / `halt` / `abort` / `cancel` now stops a run in flight. With nothing
  running it is still an ordinary message, so "stop sending the Friday digest"
  remains a request the bot thinks about rather than a silent no-op.
- **Every summarizer run destroyed that day's summary.** `writeSummary` used
  `writeFileSync`, and the checkpoint means each run only covers messages since
  the last one — so an hourly summarizer replaced the whole day with a summary of
  the last hour. Observed on a live host: a day with 14 completed conversations
  had a "daily" summary reading *6 messages summarized*. Summaries now append,
  each batch timestamped. This silently truncated the memory that cross-session
  recall reads, in both `bot.js` and `summarize.js`.
- **Two channels with the same name shared one summary file.** The owning channel
  id is now recorded in the file, and a second channel with the same (or
  same-sanitising) name gets its own.
- **A file written for one channel could be attached in another.** The outbox was
  a single shared directory, `MAX_CONCURRENT_CLAUDE` defaults to 2, and each run
  claimed every file whose mtime fell after its own start — including the other
  run's. A document produced for one client could land in another client's
  channel, which is exactly the separation this project advertises. The outbox is
  now scoped per channel; the shared root is only swept when nothing else is in
  flight, so a bot whose own context hardcodes the old path still works.
- **Two attachments with the same name on one message resolved to one file.** The
  saved path was keyed on the message id, so two `report.csv` on a single message
  produced the same path and the already-downloaded short-circuit handed back the
  first file's contents for the second — the bot described two attachments and
  read one, silently. Now keyed on the attachment id, which Discord guarantees
  unique per file.
- **A failed Discord login no longer leaves a zombie.** `client.login()` was an
  un-awaited promise whose rejection only reached the global handler, so the
  process stayed alive — the WebSocket server and scheduler keep the event loop
  busy — while reporting "Bot started" and "Bot is running". It now logs the cause
  and exits non-zero.
- **`ALLOWED_USERS` no longer vetoes bots already allowed by `ALLOWED_BOTS`.**
  Securing a bot with a user allowlist silently broke bot-to-bot coordination.
- The injected clock said `CDT CDT` in summer and `CST CDT` in winter, for every
  user regardless of location.
- `CLAUDE_CWD` is validated at startup instead of failing on the first message.
- The example config no longer advises storing real tokens in a JavaScript file,
  no longer configures a setting the code never read (`RECENT_CONTEXT_CHANNELS`),
  and no longer carries a stale model id.

### Removed

- `.claude/skills/implement-approved-issues` and `revise-pr-feedback` — the
  maintainers' internal delivery process, never loaded by the bot.

## [1.1.1] — 2026-05-20

Bot resilience and README positioning. See the
[release notes](https://github.com/xrgarcia/slashbin-ai-team/releases/tag/v1.1.1).

[2.0.0]: https://github.com/xrgarcia/slashbin-ai-team/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/xrgarcia/slashbin-ai-team/releases/tag/v1.1.1
