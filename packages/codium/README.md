# Codium desktop spike

This directory is an experimental desktop-client spike. It is not part of the
supported very-happy product, release artifacts, default workspace install, or
CI security boundary. The source remains as roadmap research; it must not be
presented as a shipped capability.

Maintainers who intentionally work on the spike should treat it as a separate
project, install it with an isolated package-manager store, and perform a fresh
dependency/security review before running or distributing it. In particular,
do not assume the root `pnpm-lock.yaml` covers this directory.
