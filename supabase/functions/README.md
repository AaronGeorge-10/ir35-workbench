# Supabase Edge Functions

Source of truth for the Workbench's Edge Functions. **The deployed copy is not
readable back** — a function deployed through the Supabase dashboard editor
returns "Failed to load function code / Function not found" on its Code tab,
and the dashboard's own advice is to use the CLI or the Management API. Neither
is reachable from this project's build shells, which have no network egress
except github.com.

So this directory is the only readable copy. Treat it the way `src/workbench.html`
is treated: **edit here, never in the dashboard**, and deploy from here.

## Deploying a change

The dashboard editor cannot open an existing function for editing, so a change
means delete-then-redeploy:

1. `https://supabase.com/dashboard/project/<ref>/functions/<name>/details`
   → **Delete edge function**
2. `https://supabase.com/dashboard/project/<ref>/functions`
   → **Deploy a new function** → **Via Editor**
3. Function name must match exactly, code pasted from the file here, **Deploy function**
4. Verify: an unauthenticated request must return `UNAUTHORIZED_NO_AUTH_HEADER`,
   and an authenticated one must get past the auth checks to the intended failure.

The URL and any project-level secrets survive the delete.

## Functions

- **invite-contractor** — mints the contractor's auth account for one worker
  record and emails them a link to set a password and answer their part.
  Secret required: `RESEND_API_KEY`. Leave "Verify JWT with legacy secret" OFF
  on the Settings tab — the function does its own role and MFA checks.
