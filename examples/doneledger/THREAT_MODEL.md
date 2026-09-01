# DoneLedger threat model

Scope: the public beta accepts an invoice-claim CSV and transient credentials for one dedicated, read-only Dolibarr account. One fresh Solari browser observes current ERP state and one Solari sandbox reproduces the deterministic comparison. The older seeded CLI is a separate synthetic demonstration.

| Threat | Consequence | Minimum control |
| --- | --- | --- |
| Agent self-verifies | False work is admitted | Treat CSV as a claim only; reload matching records through a fresh browser |
| Excess verifier authority | Evidence can be changed or paid | Require invoice-create and payment-create routes to return access denied before reading |
| Stale or duplicate ERP state | An old record satisfies a claim | Label the result as a point-in-time state check, compare exact invoice fields, surface missing and duplicate matches |
| Missing state becomes success | Incomplete reads are silently admitted | Default to `unknown`; only explicit deterministic rules produce `verified` |
| Arbitrary URL or redirect | Browser reaches internal or attacker-controlled services | HTTPS only; operator origin allowlist; initial DNS public-IP check; reject cross-origin targets and redirects |
| Credential disclosure | ERP account compromise | Submit server-side only; never persist credentials; no recording, profile, replay or client log |
| Cross-site form abuse or framing | A third party starts runs or tricks credential entry | Same-origin mutation checks, strict cookies, CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| Share-token theft | Private report becomes public | 256-bit token in URL fragment; persist only its hash; allow revoke/delete; expire after seven days |
| Artifact overclaim | Fingerprints are mistaken for raw proof | Retain only condensed results; disclose that hashes cannot be recalculated without source rows |
| Resource leak or credit abuse | Cost and residual access continue | One live run globally; invitation code; direct-IP rate limit; no retries; bounded SDK/page calls; cleanup in `finally` |
| Multi-instance deployment | Rate limit, lock and history diverge | Deploy exactly one long-running Node process with a persistent `data/` disk |

## Trust boundary

The uploaded manifest states expected records. Dolibarr is the observed system of record. DoneLedger proves only whether those claims match a fresh snapshot; it does not prove who created a record. The deterministic comparator maps each expected/observed pair to `verified`, `exception`, or `unknown`. A human retains validation and payment authority.

## Explicit non-goals

No bank connection, invoice approval, payment, financial-compliance claim, complete ERP export retention, cryptographic attribution of records to an agent, or claim that browser isolation equals separate organizational or hardware trust domains.
