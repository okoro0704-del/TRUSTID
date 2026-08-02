# TrustID V1 — Identity Core

Independent Identity and Trust Infrastructure for the ecosystem.

> One person → one TrustID → multiple applications.

**TrustID is not LifeOS, Digiconomy, or the Token Network.** Those apps authenticate through TrustID.

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](docs/ARCHITECTURE.md) | System boundaries and components |
| [Data model](docs/DATA_MODEL.md) | Relational schema |
| [Authentication](docs/AUTHENTICATION.md) | Registration, WebAuthn, OAuth flows |
| [API](docs/API.md) | HTTP contracts |
| [Security](docs/SECURITY.md) | Assumptions and secret handling |
| [Threat model](docs/THREAT_MODEL.md) | Threats and mitigations |
| [Device credentials](docs/DEVICE_CREDENTIALS.md) | WebAuthn platform credentials, counters, future NIBSS hooks |

## Structure

```text
apps/api           Identity service (Fastify + Prisma)
apps/web           TrustID PWA
apps/mock-lifeos   Mock relying party (OAuth + PKCE)
packages/shared    Shared types and helpers
docs/              Architecture documentation
```

## Quick start

```bash
npm run setup
```

Then in three terminals:

```bash
npm run dev:api      # http://localhost:8787
npm run dev:web      # http://localhost:5173
npm run dev:lifeos   # http://localhost:5174
```

Open the TrustID PWA at http://localhost:5173 — create a TrustID, verify (dev OTP is shown in UI/API logs), register a passkey, then try **Connect with TrustID** from mock LifeOS at http://localhost:5174.

## Tests

```bash
npm test
```

## Requirements

- Node.js 20+
- Browser with WebAuthn / passkey support (`localhost` is a valid secure context)
- Platform authenticator (Windows Hello, Touch ID, Face ID, device PIN/passcode, etc.)
