# Working on GAF

GAF is a personal Manifest V3 extension with vanilla JavaScript and no runtime dependencies or build step. Keep changes small and explain behavior changes in the README.

## Behavioral boundaries

- Check current master settings, feature settings, site exclusions, and the current tab URL before delayed or destructive work. Cancel queued work when disabled.
- Automatic meter resets run through the service worker for the requesting top frame. Preserve the extension-session retry guard across page and worker reloads.
- Automatic resets must not clear page storage or authentication cookies. Broad cookie and storage deletion belongs to an explicit manual action.
- Consent automation may choose only explicit reject-all or necessary-only controls. Do not guess what selected categories mean, accept all, or fabricate consent cookies.
- Track reversible page changes and undo only GAF-owned changes. Document cases requiring a page reload, including already-replaced custom elements and stretched timers.
- Keep early content-script and core consent rules consistent when changing either implementation.
- Keep local settings authoritative; describe sync mirrors and manual network requests accurately in privacy documentation.
- Never commit credentials, personal profiles, or private archive contents. Debug launchers must not use wildcard DevTools origins.

## Verification and delivery

Start work from a GitHub issue. The pull request must name and close that issue.

Run `node --test` and `git diff --check`. Add focused regression coverage for behavioral fixes. Distinguish mocked tests from real Helium and Windows checks; do not claim unperformed checks passed.

Use a branch and pull request for review. Do not merge or release unless requested.
