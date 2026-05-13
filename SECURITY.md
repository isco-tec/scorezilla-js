# Security Policy

## Supported Versions

The `scorezilla` package follows [Semantic Versioning](https://semver.org/).
We provide security fixes for:

| Version line | Supported          | Notes                                  |
| ------------ | ------------------ | -------------------------------------- |
| `0.x`        | :white_check_mark: | Latest minor receives security patches |

Once `1.0.0` ships, the policy will tighten to "latest two minor versions of
the current major."

## Reporting a Vulnerability

**Please do NOT open a public issue for security reports.** Public disclosure
of an unpatched vulnerability puts every consumer at risk.

Instead, use one of these private channels — both reach the same triage queue:

1. **GitHub private vulnerability reporting** (preferred):
   <https://github.com/isco-tec/scorezilla-js/security/advisories/new>

   This is the best channel: it gives us a structured place to discuss the
   issue privately, develop a fix together if you'd like, and coordinate
   disclosure timing. It also handles CVE assignment for us.

2. **Email:** [`security@scorezilla.dev`](mailto:security@scorezilla.dev).
   Use this if you prefer email or can't access GitHub. Plain-text is fine —
   we don't currently maintain a PGP key. If your report is sensitive enough
   to need encryption, ask us in the first message and we'll arrange a
   channel.

### What to include

- A description of the issue and its potential impact.
- Steps to reproduce, or proof-of-concept code.
- The package version(s) affected.
- Your contact information for follow-up questions.
- Whether you intend to publish or coordinate disclosure on a specific date.

### What to expect

These are the target windows we commit to publicly. In practice we aim to
move faster, but these are the deadlines we won't silently miss.

- **Acknowledgement** of receipt within **7 days** — usually within 48
  hours, but we won't promise faster than 7 days because off-hours,
  weekends, and travel happen and silent-miss is worse than honest-target.
- **Initial assessment** with a severity classification within **21 days**.
- **Fix and coordinated disclosure** target windows:
  - **CRITICAL / HIGH**: 90 days — the industry-standard coordinated
    disclosure window used by Google Project Zero and most major CNAs.
  - **MEDIUM**: 180 days.
  - **LOW**: best-effort; usually folded into the next planned release.
- A **CVE assignment** is requested for any vulnerability rated MEDIUM or
  higher, via GitHub's CVE Numbering Authority (CNA) workflow.

If the published windows are insufficient for a specific report (e.g.,
active exploitation in the wild), the reporter and the maintainers will
coordinate an accelerated timeline. Conversely, if our investigation
requires more time than the stated window, we will communicate that
proactively — silently missing an SLA is never the right answer.

We will credit you in the security advisory unless you prefer to remain
anonymous.

## Supply-Chain Hardening

`scorezilla` ships with several supply-chain protections that consumers can
verify independently:

- **Build provenance** (Sigstore via npm). Verify with `npm audit signatures`
  or by inspecting the publish attestation:
  <https://www.npmjs.com/package/scorezilla?activeTab=provenance>
- **Zero production dependencies.** The SDK pulls in no runtime npm packages,
  reducing transitive exposure to zero.
- **Subresource Integrity (SRI) hashes** published with every GitHub release.
  Pin both the version _and_ the SRI hash when loading from a CDN.
- **Published from a public, audited workflow** with a required-reviewer gate.
  Workflow definition: [.github/workflows/sdk-release.yml](.github/workflows/sdk-release.yml).

## Out of Scope

The following are tracked separately from this package's vulnerability
disclosure:

- **Hosted API vulnerabilities** at `*.scorezilla.dev` — report to the same
  channels; we will route to the API team.
- **Dashboard vulnerabilities** at `dashboard.scorezilla.dev` — same.
- **Third-party integrations** (Phaser, React) — report to the upstream
  project unless the issue is in our adapter code.
