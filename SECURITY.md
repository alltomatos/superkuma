# Security Policy

> [!CAUTION]
> Unfortunately, AI slop reports keep wasting maintainers' time. It will be closed and you will get banned immediately if you try to do that.

## Reporting a Vulnerability

1. Please report security issues to
   <https://github.com/alltomatos/superkuma/security/advisories/new>.
2. Please also create an empty security issue to alert the maintainers, as
   GitHub Advisories do not send a notification, and it could otherwise be missed.
   <https://github.com/alltomatos/superkuma/issues/new?assignees=&labels=help&template=security_issue.yml>

- Do not report any upstream dependency issues / scan result by any tools. It will be closed immediately without explanations. Unless you have PoC to prove that the upstream issue affected SuperKuma.
- Do not use the public issue tracker or discuss it in public as it will cause
  more damage.
- Do not report any SSRF issues.

## Do you accept other 3rd-party bug bounty platforms?

At this moment, we DO NOT accept other bug bounty platforms. To minimize risk,
please report through GitHub Advisories only. 3rd-party bug bounty platform
emails will be ignored.

## Supported Versions

### SuperKuma Versions

You should use or upgrade to the latest version of SuperKuma.
All versions are upgradable to the latest version.

### Upgradable Docker Tags

| Tag             | Supported          |
| --------------- | ------------------ |
| 2               | :white_check_mark: |
| 2-slim          | :white_check_mark: |
| next            | :white_check_mark: |
| next-slim       | :white_check_mark: |
| 2-rootless      | :white_check_mark: |
| 2-slim-rootless | :white_check_mark: |
| 1               | ⚠️ Deprecated      |
| 1-debian        | ⚠️ Deprecated      |
| latest          | ⚠️ Deprecated      |
| debian          | ⚠️ Deprecated      |
| All other tags  | ❌                 |
