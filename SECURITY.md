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

2. **Email:** `security@scorezilla.dev` — encrypted with our PGP key on
   request.

### What to include

- A description of the issue and its potential impact.
- Steps to reproduce, or proof-of-concept code.
- The package version(s) affected.
- Your contact information for follow-up questions.
- Whether you intend to publish or coordinate disclosure on a specific date.

### What to expect

- **Acknowledgement** of receipt within **72 hours**.
- **Initial assessment** with a severity classification within **7 days**.
- **Fix and coordinated disclosure** within **30 days** for HIGH/CRITICAL
  severity; longer for lower-severity issues, communicated case-by-case.
- A **CVE assignment** for any vulnerability rated MEDIUM or higher,
  requested via GitHub's CVE numbering authority (CNA) workflow.

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
