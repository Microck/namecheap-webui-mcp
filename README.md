# namecheap-webui-mcp

MCP server for managing Namecheap through the normal web dashboard (no Namecheap API key, no IP allowlist).

This server uses fresh Playwright sessions plus saved auth state (`storage-state.json`) so reads/writes survive between calls without relying on fragile persistent browser profiles.

## quick start

```bash
npm install
npx playwright install chromium
npm run build
npm start
```

## tools

| Tool | Purpose |
|------|---------|
| `namecheap_webui_status` | Check if saved auth state is logged in |
| `namecheap_webui_login` | Username/password login + optional 2FA submit |
| `namecheap_webui_import_cookies` | Import a full logged-in cookie set |
| `namecheap_webui_query` | Open dashboard views and return text snapshot |
| `namecheap_dashboard_list_options` | List currently visible dashboard links |
| `namecheap_domains_list` | List domains from Domain List |
| `namecheap_domain_get_overview` | Read Domain Manage overview |
| `namecheap_domain_get_nameservers` | Read nameserver mode and custom nameservers |
| `namecheap_domain_set_nameservers` | Set Basic/Free/Premium/Custom nameservers |
| `namecheap_domain_get_features` | Read auto-renew/domain-lock/whois-privacy state |
| `namecheap_domain_set_feature` | Set one of those feature toggles |
| `namecheap_dns_get_records` | Read Advanced DNS host records |
| `namecheap_dns_set_records` | Append/replace Advanced DNS host records |

## supported dashboard views (`namecheap_webui_query`)

- `account`
- `domains`
- `expiring`
- `hosting`
- `private-email`
- `ssl-certificates`
- `apps`
- `my-offers`
- `profile`
- `growth-tools`
- `advanced-dns` (requires `domainName`)
- `domain-manage` (requires `domainName`)

## env

Copy `.env.example` and adjust if needed:

```bash
cp .env.example .env
```

- `NAMECHEAP_BASE_URL` (default `https://www.namecheap.com`)
- `NAMECHEAP_LOGIN_URL` (default `https://www.namecheap.com/myaccount/login/`)
- `NAMECHEAP_ACCOUNT_URL` (default `https://ap.www.namecheap.com/`)
- `NAMECHEAP_USER_DATA_DIR` (default `.namecheap-profile`)
- `NAMECHEAP_BROWSER_EXECUTABLE_PATH` (optional, e.g. `/usr/bin/chromium-browser`)
- `NAMECHEAP_HEADLESS` (default `true`)
- `NAMECHEAP_SLOW_MO` (default `0`)
- `NAMECHEAP_NAVIGATION_TIMEOUT_MS` (default `30000`)

## login flow

1. call `namecheap_webui_login` with `username` + `password`
2. if result is `two-factor-required`, call again with `twoFactorCode`
3. verify with `namecheap_webui_status`

If direct login is blocked by anti-bot friction on your host, import a full logged-in cookie set with `namecheap_webui_import_cookies`.

## recommended safety workflow

1. `namecheap_webui_status`
2. `namecheap_domain_get_overview` / `namecheap_domain_get_nameservers`
3. `namecheap_dns_get_records`
4. `namecheap_dns_set_records` (prefer `append`)

For domain-level changes:

1. `namecheap_domain_get_features`
2. `namecheap_domain_set_feature`

## mcp config example

```json
{
  "mcp": {
    "namecheap-webui": {
      "type": "local",
      "enabled": true,
      "command": ["node", "/absolute/path/namecheap-webui-mcp/dist/index.js"],
      "environment": {
        "NAMECHEAP_USER_DATA_DIR": "/absolute/path/namecheap-webui-mcp/.namecheap-profile",
        "NAMECHEAP_HEADLESS": "true",
        "NAMECHEAP_NAVIGATION_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

## limitations

- Depends on live Namecheap markup and labels; selectors may need updates when UI changes
- Bulk operations are still modeled as single-domain actions
- Some accounts/domains may require extra verification dialogs before edits are allowed
