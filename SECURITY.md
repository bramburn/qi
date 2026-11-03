# Security Policy

This document describes the security model behind qi and where its boundaries are.

In general qi is a coding agent that runs locally within the security boundary of
the user that is running it. It is the responsibility of the user to monitor its
operations or to contain it within a container, virtual machine, or other sandbox
solution.

qi treats the local user account and files writable by that account as inside the
same trust boundary as the qi process itself. If an attacker can modify files
under the user's home directory, workspace, shell startup files, environment, or
qi configuration, they can generally influence qi or other local developer tools.
Reports that depend on such prior local write access are not security
vulnerabilities unless they demonstrate how qi grants that write access or crosses
an operating-system privilege boundary.

qi relies on users installing trustworthy extensions and loading trustworthy
skills, and on using qi only within trusted repositories. This is because files
like `AGENTS.md` or instructions in comments can be used to prompt inject the
coding agent trivially and this cannot be protected against.

## Reporting a Vulnerability

If you believe you found a security vulnerability in qi or another package in
this repository, please report it privately by opening a private report through
GitHub Security Advisories for [bramburn/qi](https://github.com/bramburn/qi/security/advisories/new).

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- Affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports. Reports are reviewed
and disclosure is coordinated as appropriate.

## Scope

Security issues in the distributed packages, command-line tools, APIs, and
repository code are in scope. qi operates no hosted infrastructure, so there is no
server-side surface in scope.

## Out Of Scope

- Local code execution or sandboxing behavior (qi intentionally does not have a sandbox)
- Behavior of qi extensions or skills installed by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Issues caused by non trustworthy MITM proxies
- Public internet exposure of a qi installation
- Prompt injection attacks
- Exposed secrets that are third-party/user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `~/.qi`,
  `~/.qi/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions,
  extension configuration, dotfiles, and files synchronized through NFS, roaming
  profiles, or dotfile managers, unless the report shows how qi itself grants
  that access.
- Issues caused by intentionally weakened user configuration.
- Resource/DOS claims that require trusted local input/config against the qi coding agent.
- Reports about malicious model output.
- User-approved or user-initiated local actions presented as vulnerabilities.

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact. Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted extension/skill are not security
vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted qi
configuration file cause qi to execute commands, load attacker-controlled tools,
send credentials to an attacker-controlled endpoint, or otherwise change behavior
is out of scope.

When possible, include the exact affected path, package version or commit SHA,
configuration, and a proof of concept against the latest release or latest `main`.
For dependency reports, include evidence that the shipped dependency is affected
and that the issue is reachable through qi.