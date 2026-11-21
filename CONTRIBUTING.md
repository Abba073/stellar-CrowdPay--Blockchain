# Contributing to CrowdPay

CrowdPay uses [GrantFox](https://grantfox.xyz) to fund and coordinate open-source contributions. Contributors pick a funded issue, build it, and submit a PR. One issue per contributor at a time.

---

## Quick Setup

### Docker (fastest)

```bash
git clone https://github.com/Savitura/crowdpay.git
cd crowdpay
cp .env.example .env                  # docker compose DB credentials
cp backend/.env.example backend/.env  # backend config (single source of truth)
docker compose up
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend | http://localhost:3001 |
| API docs | http://localhost:3001/api/docs |

### Manual

```bash
# Backend
cd backend && npm install && cp .env.example .env
npm run migrate:fresh
npm run dev          # http://localhost:3001

# Frontend (new terminal)
cd frontend && npm install && npm run dev   # http://localhost:5173
```

Fund your testnet platform account:
```bash
curl "https://friendbot.stellar.org?addr=<PLATFORM_PUBLIC_KEY>"
```

---

## Picking Up an Issue

1. Find an open, unassigned issue in [GitHub Issues](https://github.com/Savitura/crowdpay/issues)
2. Comment to claim it — wait for assignment before starting
3. Fork and branch off `main`: `feat/issue-<number>-short-description`
4. Stay current with `git rebase origin/main`

Read the full issue body before writing any code. Each issue has an acceptance criteria checklist — that's what your PR needs to satisfy.

---

## Working with AI Agents

AI coding assistants (Claude Code, Cursor, Copilot, etc.) are welcome and encouraged. They're especially effective on this codebase because the issues are written with enough context to be used directly as prompts. That said, **the contributor is responsible for everything in the PR** — unreviewed AI output that breaks tests or ignores the acceptance criteria will be closed.

### Effective patterns

**1. Start with a read, not a write**

Ask the agent to read the relevant files before it touches anything:

```
Read these files first:
- backend/src/services/emailService.js
- backend/src/services/campaignStatusService.js
- backend/src/routes/campaigns.js

Then tell me what you understand about how campaign status changes work
and what changes the following issue requires. Don't write code yet.

[paste issue body]
```

This surfaces misunderstandings before they become bad diffs.

**2. Give it the issue verbatim**

The issues in this repo are written to be machine-readable. Paste the full body — don't paraphrase. The acceptance criteria especially should be passed in exactly as written so the agent can check against them.

**3. Point it at existing patterns**

The codebase has consistent patterns. Tell the agent what to follow:

```
The pattern for a new route is in backend/src/routes/contributions.js.
The pattern for a new service is in backend/src/services/contributionService.js.
Follow the same structure for this new feature.
```

**4. Ask it to verify acceptance criteria before finishing**

```
Before you consider this done, go through each acceptance criteria item
in the issue and confirm whether your implementation satisfies it.
Flag any that you're unsure about.
```

**5. Review every diff yourself**

Agents commonly:
- Add imports for packages that don't exist in `package.json`
- Skip the error cases listed in acceptance criteria
- Change code unrelated to the issue
- Add unnecessary comments or files

Read the diff. Run `npm test`. Don't open the PR until both are clean.

### What not to do

- Don't commit code you haven't read
- Don't let the agent add files the issue didn't ask for (extra docs, helpers, config)
- Don't use the agent to write the PR description — write it in your own words

---

## Running Tests

```bash
cd backend  && npm test    # Node test runner + Supertest
cd frontend && npm test    # Vitest
```

All tests must pass before submitting a PR. CI runs the same suite on every push.

---

## Code Style

- **Backend**: follow the patterns in `src/routes/` and `src/services/`; 2-space indent; single quotes; no semicolons debate — match what's already there
- **Frontend**: functional components only; follow the existing page/component structure
- **Database**: schema changes go in a new `db/migrations/` file named `YYYYMMDDHHMMSS_description.sql` using the current UTC time — never edit `schema.sql` or rename existing migrations
- **Comments**: only add one if the *why* is genuinely non-obvious. Don't describe what the code does
- **No extra files**: don't add `.md` docs, `NOTES.md`, `TODO.md`, config files, or example scripts unless the issue asks for them

---

## Opening a PR

**Title**: `feat: <short description> (closes #<number>)`

**Body should include**:
- What you built
- Any decisions you made that weren't obvious from the issue
- How a reviewer can test it manually (exact steps)

Always include `Closes #<issue-number>` so the issue auto-closes on merge.

**Checklist before submitting**:
- [ ] All acceptance criteria in the issue are satisfied
- [ ] `npm test` passes in both `backend/` and `frontend/`
- [ ] No files added beyond what the issue required
- [ ] PR is against `main`, branch is rebased and clean

---

## Questions

Comment on the issue thread. Don't open a new issue to ask about an existing one.
