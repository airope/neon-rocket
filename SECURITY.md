# Security

Neon Rocket is experimental software, not a hardened multi-tenant service. Release preparation includes targeted code review and local adversarial regression tests; this is not an independent professional security certification or a supported-version guarantee.

## Deployment boundary

- Default bind is explicitly `127.0.0.1`. Set `HOST` deliberately for deployment; the console's localhost label alone is not evidence of bind scope.
- Browser Socket.IO origins are checked at transport admission and by CORS. Configure exact public `ALLOWED_ORIGINS`; default is localhost/127.0.0.1. Clients without Origin are intentionally allowed for command-line tools. Origins are not authentication and can be forged by non-browser clients.
- Room codes grant anonymous access; there are no user accounts. Codes use cryptographic randomness, but they are not substitutes for authenticated membership.
- Pending and active rooms, connections, message size and event/creation rates are bounded. Rooms expire and stale inputs are neutralized. See [self-hosting](docs/SELF_HOSTING.md) for defaults and reverse-proxy limitations. These safeguards are not DDoS protection or measured production capacity.
- Forwarded IP headers are not trusted. A reverse proxy's users share its source-address quota unless an operator adds appropriate edge controls.
- AI statistics and diagnostic HTTP APIs remain unauthenticated. The bot duel runs continuously; SQLite has no automatic retention limit. Monitor resource growth and apply HTTP rate limits at the edge.
- Use HTTPS/WSS, process supervision, restricted filesystem permissions and updated dependencies. Native/WASM provenance and licenses are recorded, but passing native tests is not a complete binary security audit.

Never put credentials, private files or runtime databases under `public/`, `shared/`, or the served native distribution directory. Treat those routes as public.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** channel when enabled. If it is unavailable, ask the maintainer to establish a private channel without including exploit details in a public issue. Do not send secrets, personal data or complete runtime databases.

Provide the affected revision, engine/mode, sanitized reproduction steps, impact and suggested mitigation. Test only a local instance you own or a system you have explicit permission to assess. Do not exhaust resources or probe other players' sessions on public demos.

Deployment-specific protections and a maintained reporting channel are required before presenting any installation as a supported public service.
