## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!-- What goes wrong without it. If this adds a guard that looks redundant, say
     what happens when it is removed — that comment is the point of the change. -->

## Checks

- [ ] `npm test` passes
- [ ] `node --check bot.js && node --check summarize.js` passes
- [ ] New or changed settings are in the README config table **and** `.env.example`
- [ ] Tested against a real bot (say which Discord setup, briefly)

## Compatibility

- [ ] **Additive** — an existing operator changes nothing and sees no difference
- [ ] **Behaviour change** — `UPGRADING.md` entry added, and the upgrade is a
      short, copy-pasteable change

<!-- No removed or renamed settings without a deprecation that keeps the old name
     working for at least one minor release. Breaking changes are major-version
     only. See CONTRIBUTING.md. -->

## Anything a reviewer should look at closely

<!-- The bit you are least sure about. -->
