# Security

Report a vulnerability privately through GitHub: on this repository's **Security** tab, select
**Report a vulnerability**. Do not open a public issue.

Include the version you tested, the steps to reproduce, and what an attacker gains. EtherPK's Sync
Server is designed never to read graph content, so a way to recover plaintext notes, keys or a
Recovery Code from anything the server stores or relays is in scope and the most serious class of
report. So is a way for the server to make a Client accept keys it did not check: a forged invite,
key write or copy of a graph's key, a changed key for someone the user has verified, or a device
approval that does not show different codes on the two screens. A way to run script in the Client's
page past its Content Security Policy and Trusted Types is also serious, because the page holds the
keys.
