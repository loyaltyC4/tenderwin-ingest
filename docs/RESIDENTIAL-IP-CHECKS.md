# Getting the rest of the tender documents: residential IP checks

Goal: documents for WA, VIC and ACT tenders (about 200 open tenders have none). No credentials belong in this file.

## What we already know (tested 2026-11-20/21)

| Portal | Public list pages | Documents | Blocker found |
|---|---|---|---|
| NSW | open | stored in R2, working | none |
| WA | 200 from a home IP | behind a supplier login + email code | GitHub runner IPs get 403 |
| VIC | open | behind a login | login fails in the runner (needs a working VIC account) |
| ACT | 403 from plain requests | public downloads | Cloudflare JavaScript challenge on every request |
| Static AU proxy (Vocus, Melbourne, SOCKS5) | works for normal sites | not usable | SOCKS reply 2 "not allowed by ruleset" for every .gov.au host (tested 2026-11-22) |
| DataImpulse proxy | works for normal sites, AU IP | not usable | answers `403 SITE_PERMANENTLY_BLOCKED` for every .gov.au host |

So the problem is two different things: WA is an IP problem, ACT is a bot-check problem, VIC is a missing account.

## Check 1: is it the IP? (2 minutes, run on your Mac)

```bash
curl -s -o /dev/null -w "WA %{http_code}\n"  "https://www.tenders.wa.gov.au/watenders/tender/search/tender-search.do?action=advanced-tender-search-open-tender"
curl -s -o /dev/null -w "VIC %{http_code}\n" https://www.tenders.vic.gov.au/
curl -s -o /dev/null -w "ACT %{http_code}\n" https://www.tenders.act.gov.au/
curl -s https://ipinfo.io/country
```

Read it like this:
- 200 on WA and VIC from your Mac but 403 from GitHub = the portals block datacentre IPs, a home IP is enough. The Mac runner (already installed) is the fix.
- 403 on ACT even from your Mac = it is the Cloudflare challenge, not the IP. Go to Check 3.

## Check 2: will a paid residential proxy reach government sites?

DataImpulse will not. Before paying any other provider, test with their trial using the same command:

```bash
curl -sv -x "http://HOST:PORT" --proxy-user "USER:PASS" https://www.tenders.wa.gov.au/ -o /dev/null 2>&1 | grep -E "^< HTTP"
```

- `HTTP/1.1 200 Connection established` then a normal page = usable.
- `403 ... BLOCKED` or a refused tunnel = the provider bans .gov targets. Do not buy.
Ask the provider in writing whether .gov.au targets are allowed. Many residential networks restrict government domains.

## Check 3: ACT needs a real browser (CloakBrowser)

ACT returns a Cloudflare "just a moment" page to anything that is not a real browser. CloakBrowser is a stealth Chromium, so test it:

1. Launch CloakBrowser on the Mac (home IP) and open `https://www.tenders.act.gov.au/`.
2. Wait up to 15 seconds. Pass = the tender search page appears, not "Just a moment".
3. Open one open tender, note whether a documents link is visible without a login.
4. Repeat the same on a RunPod pod. If it fails there but passes on the Mac, the IP is the difference, and RunPod is not useful for ACT.

## Check 4: what RunPod is and is not good for

- RunPod IPs are datacentre addresses. WA and Cloudflare treat them like GitHub, so expect the same block.
- Check the region list when you create a pod. If there is no Australian region, it adds nothing over GitHub.
- It is useful only for heavy compute (reading large PDFs, OCR), not for getting past the portals.

## Recommended order

1. WA: run on the Mac (done: runner `tw-mac-wa`, workflow `wa-docs-mac.yml`, every 3 hours when the Mac is awake).
2. ACT: Check 3 with CloakBrowser on the Mac. If it passes, add a Playwright/CloakBrowser step to the same Mac runner.
3. VIC: you create a VIC supplier account, I put the login into GitHub secrets and move the VIC docs job to the Mac runner.
4. Only if the Mac is too often asleep: look for a residential provider that allows .gov.au (Check 2), or a small always-on machine with an Australian home or office connection.

## Notes
- The Mac runner only runs when the Mac is awake and online. Missed runs queue for up to a day.
- Rotate every credential that was pasted in chat: R2, VIC, TinyFish, DataImpulse.
