# DoneLedger threat model

Scope: a synthetic AP demonstration using two Solari browser sessions, an external Dolibarr instance, and a Solari comparison sandbox. It does not cover production financial data or payment execution.

| Threat | Consequence | Minimum control |
| --- | --- | --- |
| Worker self-verifies | False work is admitted | Fresh verifier account and browser; no worker cookies, memory, export, or claimed result used as evidence |
| Excess worker authority | Worker validates or pays | Enable `MAIN_USE_ADVANCED_PERMS`; grant only read/create-draft; execute negative validation and payment checks |
| Verifier mutation | Evidence can be repaired after the fact | Read/export only; execute a negative create/update check |
| Shared credentials or sessions | Separation is nominal | Distinct users and profiles; no credential inheritance; destroy sessions after the run |
| Manifest tampering | Comparator validates against attacker-controlled truth | Version and hash the source fixture before worker execution; record the hash in the result |
| Ambiguity becomes success | Missing or unparsable state is silently admitted | Default to `unknown`; only explicit deterministic rules can produce `verified` |
| Duplicate or stale ERP state | Prior records satisfy a new claim | Dedicated synthetic instance; idempotent supplier-reference lookup; reject excess records; flag duplicate job IDs; record fresh observation metadata |
| Artifact tampering | Public UI misstates the run | Publish raw `run.json` with source/export hashes; UI only renders the artifact and never upgrades a decision |
| Prompt injection in ERP content | Untrusted supplier or invoice text redirects the browser worker | Treat page content as data; use fixed navigation and field mappings; reject any instruction discovered inside ERP records |
| Secret or replay disclosure | ERP or Solari session compromise | Environment secrets; redact logs; never publish cookies, passwords, signed URLs, session IDs, or sensitive replays |
| Resource leak | Cost and residual access continue | Close browser clients and kill sandboxes in `finally`; audit active resources after failures |
| Demo interference or reset | Evidence is incomplete or belongs to another user | Dedicated authorized instance; synthetic data; fail closed if run identity cannot be established |

## Trust boundary

The source manifest states expected work. Dolibarr is the observed system of record. The worker may write drafts but cannot decide admission. The verifier may observe but cannot repair state. The deterministic comparator alone maps an expected/observed pair to `verified`, `exception`, or `unknown`. A human retains validation and payment authority.

## Explicit non-goals

No bank connection, invoice approval, payment, production PII, financial compliance claim, adversarial security audit of Dolibarr or Solari, cryptographic proof that every ERP record was created during the same run, or claim that browser-session separation is equivalent to separate organizations or hardware trust domains.
