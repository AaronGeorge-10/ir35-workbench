# IR35 Workbench

Ascend People Solutions Ltd. The Workbench is **Ascend's intellectual property**, leased to
end-hirer clients. Ørsted is client #1, not the owner.

**This repository is the single source of truth for the deployed tool.** It is not a copy of
something else. If a file on someone's laptop disagrees with this repository, this repository wins.

---

## The one rule

**Never hand-edit a client folder.** `orsted/index.html` is a generated file. Edit
`src/workbench.html`, then rebuild. A change made directly in a client folder is silently
overwritten by the next build — and hand-editing per-client copies is precisely what caused the
three live builds to diverge (pre-go-live debt register, B-03).

---

## Layout

| Path | What it is |
|---|---|
| `src/workbench.html` | **The application.** One file, tokenised with `{{PLACEHOLDERS}}`. The only file you edit. |
| `clients/<client>.json` | Per-client configuration: folder, tenant names, Supabase project, adviser, reviewer. |
| `clients/_example.json` | Copy this to onboard a new client. Contains the onboarding checklist. |
| `assets/` | Logo and user guides copied into every client folder at build time. |
| `build.py` | The builder. |
| `orsted/` | **Generated.** Client #1, live. |
| `Orsted/` | Redirect stub only — preserves the old capitalised URL, including the auth hash fragment. |
| `index.html` | Root holding page. |
| `CNAME`, `robots.txt`, `_config.yml` | Hosting configuration. Site is noindexed and disallowed to crawlers. |

## Building

```
python3 build.py            # rebuild every client
python3 build.py orsted     # rebuild one client
python3 build.py --check    # fail if the committed output is not a fresh build
```

Run `python3 build.py --check` before every push. If it reports STALE, someone hand-edited a
generated folder and their change is about to be lost — find out what it was before rebuilding.

## Deploying

Commit and push to `main`. GitHub Pages serves `main` at the repository root. Nothing else is
required, and **nothing should ever be uploaded through the GitHub web interface by hand** — that
is how a stale local copy reverts live fixes.

A web-upload commit does not always trigger a Pages build; a normal `git push` does.

## Onboarding a new client

1. Copy `clients/_example.json` to `clients/<client>.json` and work through the checklist inside it.
   Every client gets **its own Supabase project in London (eu-west-2)** — physical isolation, never
   a shared project with a tenant column.
2. `python3 build.py <client>`
3. Commit, push, wait for the Pages deploy.
4. Run the isolation self-test before handing over the URL: sign in as the new client and prove you
   cannot read another client's store.

## URLs

- Canonical: `https://ir35workbench.co.uk/orsted/`
- Legacy `https://ir35workbench.co.uk/Orsted/` redirects to it and preserves `?query` and `#hash`.

GitHub Pages paths are case-sensitive, so client folder names are **always lowercase**; the builder
refuses a config whose `folder` is not.

## Known limitations recorded elsewhere

This README covers the build system only. Outstanding functional and security work is tracked in
`IR35_Workbench_PreGoLive_Debt_Register_2026-08-20.md` (held with the project files, not in this
repository). At the time of writing, the tool has issued **no** real worker determinations.
