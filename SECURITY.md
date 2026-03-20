# Security Policy

## Supported Scope

This project is still evolving and does not currently provide formal security support guarantees across all historical versions.

Security-sensitive areas include:

- provider credentials handled through `keytar`
- local filesystem indexing
- document parsing and OCR dependencies
- Electron main/renderer boundary

## Reporting a Vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Instead, report the issue privately to the project maintainer with:

- a description of the issue
- affected area or file path
- reproduction steps
- impact assessment
- any suggested remediation if available

If private contact details are not yet published in the repository profile, open a minimal public issue asking for a private reporting channel without disclosing the vulnerability details.

## What to Expect

- Good-faith reports will be reviewed.
- Valid issues will be triaged and fixed based on severity and available maintainer time.
- Coordinated disclosure is preferred until a fix or mitigation is available.

## Secrets and Local Data

- Do not include real API keys, credentials, or private documents in bug reports.
- Reproduce issues with sanitized data whenever possible.
- If a report involves indexed local files, share only the minimum metadata needed to understand the problem.
