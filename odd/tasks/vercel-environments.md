# Vercel Environments — ODD Task Record

## Objective

Leave ready two environments on restart: test (preview) and production,
both connected to Supabase, with correct env vars per environment.

## Context

- Supabase MCP configured + authenticated (project_ref pcpzncdfyevzylyokdjg).
- Vercel MCP configured + authenticated (project opencode.json already had it).
- Branch feat/orabella-mvp pushed (up to d6da175 + cash-control commits).
- Pending DBA: apply migrations 009_cash_control + 010_cash_denominations.
- MCP tools load at session start: after restart, supabase + vercel tools
  should be available. If subagent transport still rejects free tier,
  continue inline.

## Tasks (stable IDs)

- [ ] ENV-01 Apply migrations 009 + 010 via Supabase MCP/database tools and verify tables.
- [ ] ENV-02 Link Vercel project (or create) to D:/u/orabella/app.
- [ ] ENV-03 Configure env vars per environment (Supabase URL/keys, session secrets): preview vs production.
- [ ] ENV-04 Deploy preview (test) from feat/orabella-mvp; smoke test /api/v1/health + /login.
- [ ] ENV-05 Deploy production (main or tagged release, user decision); smoke test.
- [ ] ENV-06 Record URLs, env mapping and evidence; delivery decisions to the user.

## Constraints

- Never print secrets; reference env var names only.
- Production deploy only with explicit user approval (which ref).
- Push/PR remain user decisions.
