# ADR 0001: Browser authentication token transport

- Status: Accepted for future F01 implementation
- Date: 2026-09-10

## Decision

The browser will receive the short-lived access token through a secure, HTTP-only, SameSite cookie.
The opaque refresh token will use a separate HTTP-only cookie scoped narrowly to the refresh route.
Production cookies require `Secure`; state-changing endpoints require same-origin enforcement and a
CSRF token where SameSite protections are insufficient.

The React application must not store access or refresh tokens in localStorage/sessionStorage. Native
or third-party clients may use an Authorization header under a separate client policy in F01.

## Why

HTTP-only cookies reduce token exposure to injected JavaScript. A narrowly scoped rotating refresh
cookie limits its use and supports reuse detection. The API still needs explicit CSRF controls because
cookie transport causes browsers to attach credentials automatically.

## Consequences

F01 must define cookie domain/path behavior, refresh rotation and logout revocation tests. CORS remains
an allowlist and credentialed requests are never permitted with a wildcard origin.
