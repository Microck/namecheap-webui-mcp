# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-03-08

### Added

- Initial MCP server implementation for Namecheap domain and DNS management via web dashboard
- 13 MCP tools covering authentication, domain management, DNS records, and dashboard navigation:
  - `namecheap_webui_status`, `login`, `import_cookies`
  - `namecheap_webui_query`, `dashboard_list_options`
  - `namecheap_domains_list`
  - `namecheap_domain_get_overview`, `get_nameservers`, `set_nameservers`
  - `namecheap_domain_get_features`, `set_feature`
  - `namecheap_dns_get_records`, `set_records`
- Fresh session architecture with `storage-state.json` for auth persistence
- Camoufox + Playwright browser support with automatic fallback
- Complete domain operations: nameservers, auto-renew, domain lock, WHOIS privacy
- Advanced DNS record management with append/replace modes
- Dashboard query tool supporting 12 different views
- Verification scripts (`verify-tools.ts`, `verify-code-paths.ts`, `verify-mcp-tools.ts`, `test-chromium-only.ts`)
- `VERIFICATION.md` documenting verified functionality

### Fixed

- Browser launch order: Chromium first (stable), Camoufox as fallback
- Added `--headless=old` flag for Chromium stability on problematic hosts
