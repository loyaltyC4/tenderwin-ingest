#!/usr/bin/env python3
"""Print the newest Tenders WA login token received after argv[1] (unix seconds). Read-only IMAP.
Env: GMAIL_USER, GMAIL_APP_PASS. Exits 2 when none arrives within ~100s."""
import imaplib, email, email.utils, os, re, sys, time

user, pw = os.environ["GMAIL_USER"], os.environ["GMAIL_APP_PASS"].replace(" ", "")
since = float(sys.argv[1])
deadline = time.time() + 100
while time.time() < deadline:
    m = imaplib.IMAP4_SSL("imap.gmail.com")
    m.login(user, pw)
    m.select("INBOX", readonly=True)
    _, data = m.search(None, '(FROM "tenderswa@dtf.wa.gov.au")')
    for i in reversed(data[0].split()[-5:]):
        _, d = m.fetch(i, "(RFC822)")
        msg = email.message_from_bytes(d[0][1])
        if email.utils.parsedate_to_datetime(msg["Date"]).timestamp() < since:
            continue
        body = ""
        for part in msg.walk():
            if part.get_content_type() in ("text/plain", "text/html"):
                body += part.get_payload(decode=True).decode(errors="ignore")
        t = re.search(r"Token:\s*([A-Za-z0-9]{4,12})", re.sub(r"<[^>]+>", " ", body))
        if t:
            print(t.group(1))
            sys.exit(0)
    m.logout()
    time.sleep(4)
sys.exit(2)
