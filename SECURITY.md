# Security Policy

## Supported Versions

Only the latest minor release line on `main` receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| Latest `1.x` | :white_check_mark: |
| Older       | :x:                |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security problems.**

To report a vulnerability, use GitHub's private
[Security Advisories](../../security/advisories/new) form. Only maintainers
can see reports filed through this channel.

Please include:

- A description of the issue and its impact
- Steps to reproduce (or a proof-of-concept)
- Affected SDK versions
- Your environment (Node.js version, OS)
- Any suggested fix, if you have one

We will acknowledge your report within **3 business days** and aim to provide
an initial assessment within **7 business days**. Once a fix is ready we will
coordinate a disclosure timeline with you before publishing.

## Scope

In-scope:

- Code shipped from `src/` in this repository
- Documented public APIs and their default behaviour
- Bundled examples that could mislead users into insecure patterns

Out of scope:

- Vulnerabilities in third-party dependencies (please report those upstream)
- QQ Open Platform server behaviour
- User applications that misuse the SDK (e.g. logging raw `appSecret`)

## Handling Credentials

This SDK never reads credentials from the environment on its own — the caller
supplies `appId` / `appSecret` explicitly. When reporting bugs, please redact
any real `appId`, `appSecret`, `access_token`, `openid` or user content from
your reproductions and logs.
