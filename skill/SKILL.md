---
name: namecheap-webui-mcp
description: Use when a user needs to manage Namecheap domains or DNS through the normal Namecheap website without registrar API access. Covers the working flow, the flaky parts, and the fastest fallback path.
---

# Namecheap WebUI MCP

This project exists for one reason: operate Namecheap through the regular web dashboard when the user does not have Namecheap API access.

## When To Use It

Use this MCP when the user needs to:
- inspect the Namecheap account dashboard
- discover current dashboard options and links
- list domains
- inspect Domain Manage state (nameservers, lock/privacy/auto-renew)
- set nameserver mode and custom nameservers
- toggle lock/privacy/auto-renew features
- read current DNS records
- append or replace DNS host records
- work without Namecheap API credentials or IP allowlisting

Do not assume a direct HTTP or session-token integration is the right answer here. Namecheap's normal account flow is web-login-first and often includes 2FA or trusted-device prompts.

## Core Reality

- The reliable architecture is browser automation with saved auth state reused across fresh browser sessions.
- `session-token` was the wrong default mental model for Namecheap.
- Cookie import is only a best-effort recovery path.
- The normal login path should be credential-driven in the MCP itself: username/password first, then a second call with the 2FA code if Namecheap asks for it.

## Tools

- `namecheap_webui_status`
  - Check whether the saved auth state is authenticated.
  - Run this first before any write action.

- `namecheap_webui_login`
  - Runs the normal Namecheap login flow and persists the resulting auth state.
  - First call it with `username` and `password`.
  - If the result says `two-factor-required`, call it again with `twoFactorCode`.
  - `headed: true` is only for local debugging, not the normal path.

- `namecheap_webui_import_cookies`
  - Imports Playwright-compatible cookies into the saved auth state.
  - Use only if interactive login is failing.
  - Full cookie export may still fail if Namecheap expects more browser state than cookies alone.

- `namecheap_webui_query`
  - Opens a high-level account, domain-list, or advanced-DNS view and returns a short text snippet.

- `namecheap_dashboard_list_options`
  - Returns currently visible dashboard links with labels and href values.

- `namecheap_domains_list`
  - Lists domains visible in the dashboard.

- `namecheap_domain_get_overview`
  - Returns Domain Manage summary data (expiry hint, nameserver mode, core feature states, snippet).

- `namecheap_domain_get_nameservers`
  - Reads nameserver mode and custom nameserver input values.

- `namecheap_domain_set_nameservers`
  - Sets Basic/Free/Premium/Custom nameserver mode and writes custom nameserver values.

- `namecheap_domain_get_features`
  - Reads Domain Manage toggles for auto-renew, domain-lock, and whois-privacy.

- `namecheap_domain_set_feature`
  - Sets one of those feature toggles to enabled/disabled.

- `namecheap_dns_get_records`
  - Reads current host records from Advanced DNS.

- `namecheap_dns_set_records`
  - Appends or replaces host records.
  - `append` is the safe default.
  - `replace` is destructive because it deletes visible records first.

## Recommended Workflow

### 1) Check auth first

Call `namecheap_webui_status`.

- If authenticated, continue with normal read/write tools.
- If not authenticated, choose one of the login flows below.

### 2) Normal login flow

Use `namecheap_webui_login` in two steps:
1. call it with `username` and `password`
2. if it returns `two-factor-required`, call it again with `twoFactorCode`

Why this is preferred:
- it keeps each operation in a fresh browser session
- it works on headless hosts without VNC glue
- it matches the real operator workflow more closely than remote desktop hacks

## DNS Safety Rules

- Always call `namecheap_dns_get_records` before `namecheap_dns_set_records`.
- Prefer `append` unless the user explicitly wants a full replacement.
- Namecheap host records are editable only when the domain uses `BasicDNS`, `FreeDNS`, or `PremiumDNS`.
- If the domain uses custom nameservers, the MCP should be treated as read-only for DNS changes.
- Use exact full domain names like `example.com`.

## Known Gotchas

- Namecheap's official API is not a drop-in alternative here. It requires API access and IP allowlisting.
- The live site can show anti-bot friction during login.
- 2FA and trusted-device prompts are normal, not edge cases.
- Cookie import may report success but still fail to authenticate the account.
- The selectors depend on live Namecheap dashboard markup, so future layout changes may require updates.
- If the legacy profile is locked by another Chromium process, close that browser before retrying migration.

## Build And Run

From `namecheap-webui-mcp/`:

```bash
npm install
npx playwright install chromium
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Environment Notes

Most important variables:
- `NAMECHEAP_USER_DATA_DIR`
- `NAMECHEAP_BROWSER_EXECUTABLE_PATH`
- `NAMECHEAP_HEADLESS`
- `NAMECHEAP_NAVIGATION_TIMEOUT_MS`
Use `NAMECHEAP_HEADLESS=false` only when you have a real local GUI and need to debug login issues.
If `NAMECHEAP_USER_DATA_DIR` already contains an older Playwright persistent profile, the MCP will try a one-time migration to `storage-state.json`.

## Operator Checklist

Before reads:
- confirm authentication with `namecheap_webui_status`

Before writes:
- read current records first
- confirm the domain is on Namecheap DNS
- prefer `append`

When stuck:
- inspect whether Namecheap changed the login or 2FA fields
- treat cookie import as a recovery attempt, not a guarantee
- verify the saved auth state still includes the expected Namecheap auth cookies
