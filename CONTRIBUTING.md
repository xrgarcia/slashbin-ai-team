# Contributing

Thanks for looking. This is a small, sharp codebase — three source files and no
build step — so contributing is mostly reading, changing, and running the tests.

## Getting set up

```bash
git clone https://github.com/xrgarcia/slashbin-ai-team.git
cd slashbin-ai-team
npm install
npm run setup     # interactive; validates as it goes
npm run doctor    # confirms the config actually works
npm test
```

You need Node 18+ and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code),
installed and authenticated.

## Branches

`features → develop → main`. **`features` is where work lands.** Open pull
requests against it. `main` is what people clone, so it only moves at a release.

## Running the tests

```bash
npm test
```

Four suites, all plain Node — no framework, no runner.

**The tests assert against the source text rather than importing `bot.js`.** That
is deliberate: importing it logs a live bot into Discord. If you are adding
coverage, follow the existing pattern — extract the function or constant from the
source and evaluate it in a controlled context (`test/attachments.test.js` shows
the shape).

## The house style, such as it is

**Comments explain *why*, and usually name the incident that caused the guard.**
This is the single most useful convention in the codebase. Compare:

```js
// Skip if already downloaded
```

with:

```js
// A file drops out of the buffer long before the conversation about it ends —
// the Claude session still holds its path and will Read it. Only reap files
// older than the window the summaries cover.
```

The second one stops someone "simplifying" the guard away in six months. If you
are adding a check that looks redundant, write down what happens without it.

Other things worth knowing:

- No TypeScript, no transpiler, no bundler. What is on disk is what runs.
- Match the surrounding code. There is no linter to argue with you.
- Prefer a small, explicit function over a clever one.

## Before you open a pull request

- [ ] `npm test` passes.
- [ ] `node --check bot.js && node --check summarize.js` passes.
- [ ] New or changed settings are in the README config table **and** in
      `.env.example`. A setting nobody can find is not configurable.
- [ ] If you removed a setting, deprecate it first — see below.
- [ ] If behaviour changed for an existing operator, add an `UPGRADING.md` entry.

## Backward compatibility is a hard rule

People run this against their own bots and their own repos. Their configuration
is a contract.

- **Additive by default.** New optional settings, new commands, new behaviour
  behind a flag — fine.
- **No removed or renamed settings** without keeping the old name working for at
  least one minor release, with a deprecation warning naming the replacement.
- **No changed defaults** without an `UPGRADING.md` entry saying what changed and
  what to set to keep the old behaviour.
- **Breaking changes only in a major version.**
- State the resolution order for anything with precedence. Today it is simply:
  environment variable → default.

The test for whether you got this right: an operator on the previous release
should be able to upgrade by reading one short section, not by diffing the source.

## Reporting bugs

Open an issue using the template. Please include the output of `npm run doctor` —
it answers most of the first round of questions, and it never prints secrets.

## Security

Do not open a public issue. See [SECURITY.md](SECURITY.md).
