# Temporary shared tabs

GAF 0.2.36 adds a first working remote-tab prototype. The extension keeps its existing vanilla-JavaScript/no-build setup. A **separate companion** runs Chromium and exposes a constrained MCP connection for an invited agent. It does not connect to daily Helium, copy its cookies, or reuse the persistent Helium GAF Debug profile.

## Start a companion locally

Requires Node 22+ and the browser dependencies for Playwright on your operating system.

```bash
cd companion
npm ci
npx playwright install chromium
```

On Linux, use `npx playwright install-deps chromium` if required system libraries are missing. On Windows use PowerShell for the following environment setup:

```powershell
$env:GAF_REMOTE_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

On Linux/macOS:

```bash
export GAF_REMOTE_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
npm start
```

Copy that **connection key** into GAF Options → Shared sessions → Add connection. Use `http://127.0.0.1:8765` for the server address. This key authorizes creation of a session; it cannot read an existing session. Store it like a password. The service refuses to start without a random key of at least 32 characters.

Give the connection a name, add your agent names (one per line), choose the inactivity timeout, and click **Save shared-session settings**. These settings have their own save button, stay in `chrome.storage.local`, and are absent from filter-pack exports and the sync mirror. Agent names are labels, not authenticated identities or automatic account integrations.

## Daily interaction

1. Open an HTTP/HTTPS website in your normal browser.
2. Open GAF's popup, choose a connection, and click **Reload this URL remotely**.
3. The same local tab becomes a remote viewer. A new browser process with a non-persistent context opens the URL; only the URL is passed. Log in manually using clicks, typing or paste into the remote page. Your local password manager does not automatically fill a pixel-based remote view.
4. Agent access starts **Off**. Choose an agent and **Read only** or **Can interact**, then click **Apply access**.
5. Expand **Connect agent**. Configure a trusted, Streamable-HTTP MCP-capable agent client with the displayed MCP address and bearer token in its Authorization header. This is a session-specific invitation; the name is a label and anyone possessing its bearer token has that grant. GAF does not send messages to agents or configure any agent automatically.
6. Use **Take over** to revoke the invitation. It invalidates old tokens and queued actions; an input action already dispatched to the browser may finish and cannot be undone.
7. **End session**, closing the local viewer tab, or navigating away ends the entire remote session, including pop-ups. Use the **Window** selector for authentication windows and **Close pop-up** to dismiss one without ending the main session.

Changing an access choice issues a fresh token. Reloading the viewer revokes the previous invitation. To change the network route, end the old session and reopen the URL with a different configured connection. Logins do not transfer between routes. Browser Back leaves the viewer and ends the session.

## Agent connection

The companion serves stateless Streamable HTTP MCP at `/mcp`, using the official MCP TypeScript SDK. Give the agent the **session invitation token**, never the companion connection key or viewer's owner token. A client must support a custom `Authorization: Bearer …` header.

- `gaf_page_read`: URL, title, visible page text, and numbered visible controls. Does not return form input values, cookies, browser storage or a CDP endpoint. Page text is untrusted website content, not instructions from the user.
- `gaf_page_click`: clicks a reference returned by the latest read. Requires **Can interact**.
- `gaf_page_fill`: fills a control from the latest read. Requires **Can interact**. Password and recognized authentication/card fields are reserved for manual entry.

The remote browser never loads cloud instance-metadata addresses (`169.254.0.0/16`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.goog`): a website could otherwise plant a link there for an agent with **Can interact** to click, then read the host's credentials from the page. Typed addresses are refused and Chromium's resolver refuses those hosts for links, redirects, frames and subresources. Other LAN addresses stay reachable, so a local companion can still open your router or NAS.

Controls are scoped to the currently selected remote window, including its frames, and references are invalidated by navigation, window changes, permissions changes and agent actions. Read again after interacting. No general JavaScript evaluation or access to other browser profiles is exposed. Interaction access can still exercise privileges of an authenticated page; it is a broad grant to act on that session, not per-purchase or per-submit approval.

## Cleanup and its limits

The service holds browser sessions, invitations and screenshots in memory, with no saved auth state, screenshot files, browser traces or page-content logs. Each session owns its browser process. Teardown revokes grants, closes the entire context and process, and removes the session from memory; Playwright cleans up its temporary profile. GAF clears its session record when the tab ends. This is disposal of application state, not a forensic secure-erasure guarantee.

- The configured **idle timeout** measures user input, agent interactions and access changes. Frame polling, reading the page and owner heartbeats do not extend it.
- A viewer heartbeat maintains a separate **90-second owner lease**. A lost browser/tab connection therefore triggers cleanup even if an agent remains connected. Sleeping computers or heavily throttled background tabs may lose their lease. Ordinary tab close/navigation also requests immediate deletion through the extension worker.
- The viewer rides out brief connection drops (Wi-Fi blips, a busy companion): it shows *Connection interrupted — retrying…* and carries on. It gives up only when the companion reports the session gone, or no heartbeat has landed for the whole 90-second lease — by then the companion has ended the session itself.
- A **one-hour maximum lifetime** caps every session, even during activity.
- Shutdown closes all sessions. A fresh process cannot restore them. Do not attach persistent browser volumes, enable browser recordings or log request bodies/Authorization headers on a hosting proxy.

GAF cannot delete an external agent's transcript, memory or screenshots, nor the destination website's own records. Use an agent/client with session-only retention if that is required. Local browser history still contains the original URL visited before remote reload and the generic viewer entry. The viewer does not put remote page URLs or titles into local navigation history. Connection names, endpoints, keys and agent names intentionally persist as setup data.

## Cloud hosting and routing

Run the same companion on your own **dedicated** host to use its network instead of this computer's network. Put it behind HTTPS, set `GAF_BIND=0.0.0.0` for the container/private interface, and set `GAF_ALLOWED_HOSTS` to the exact incoming hostnames your reverse proxy sends (comma-separated, without ports). Restrict public ingress to your HTTPS proxy; the plain HTTP backend belongs on the private network. Keep a strong connection key and do not share the machine with sensitive internal services: an authenticated browser can navigate to addresses reachable from that host. The companion blocks well-known metadata addresses and hostnames (see *Agent connection*), but not an arbitrary hostname that resolves to one, so on a cloud host also require token-based metadata access (for example AWS IMDSv2 with a hop limit of 1) or block the metadata service at the network/container level.

The included Dockerfile runs as the Playwright image's unprivileged browser user. Use a seccomp profile suitable for Chromium sandboxing, an init process and sufficient shared memory as recommended by Playwright. Provide `GAF_REMOTE_TOKEN` at runtime; it is never baked into the image.

Each saved companion endpoint is a different route; the viewer shows its connection name and server address. A locally running companion uses the local VPN if one is active. This prototype does **not** provision paid cloud infrastructure, implement proxy chains/residential exits, tunnel through another user's computer, or guarantee access to sites that block VPN/datacenter IPs. The actual egress IP is determined by the companion host's network.

## Prototype limits and verification

The viewer polls JPEG frames at up to 2.5 frames/sec, with a fixed 1280×800 remote viewport. It supports clicks, scrolling, basic keyboard input and paste. It is intended for reading, forms and shared assistance, not streaming media or a complete desktop browser. There is no audio, file transfer/downloads, drag-and-drop, IME composition, local password-manager integration or WebAuthn-device forwarding. Browser dialogs are dismissed; popup-based login can work, but flows requiring native devices, DRM or other unsupported features may not.

```bash
# Extension regression suite (no companion dependencies required):
node --test
git diff --check

# Real Chromium lifecycle and MCP checks:
cd companion
npm ci
npx playwright install chromium
npm test

# Extension → companion → remote page flow in an isolated Chromium profile:
npm run test:extension
# Optional visual check: npm run test:extension -- --screenshot=/tmp/shared-session.png
```

GitHub Actions runs the companion suite and the extension flow (job `companion`, Node 22) next to the extension regression suite.

These automated browser checks use Chromium fixtures and synthetic credentials, not the user's profiles. The extension flow renders the real popup code in an inactive extension tab because headless Chromium does not expose its toolbar popup as an automatable page. It exercises the actual extension worker, tab replacement, viewer, companion and MCP client. Live Windows/Helium, the native toolbar popup, hosted HTTPS deployment, actual provider/agent integrations and access to specific websites are separate checks and are not implied by passing the tests.
