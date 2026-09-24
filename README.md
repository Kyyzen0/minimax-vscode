# MiniMax for VS Code

This VS Code extension uses a **MiniMax Code subscription**, not a pasted API key.

It is a small ACP client for the official MiniMax Code CLI (`mcode`). The extension
never handles a MiniMax access token: `mcode login` opens the official browser
sign-in and MiniMax Code keeps the resulting credential in its own store.

## Requirements

Install the official MiniMax Code CLI and make sure `mcode --version` works in a
terminal. MiniMax documents this CLI as the subscription-aware route for coding
workflows and exposes `mcode acp` for editor clients.

```bash
npm install -g @minimax-ai/code@latest
```

## Use

1. Open this folder in VS Code and press `F5` to launch an Extension Development Host.
2. Run **MiniMax: Sign in**. An integrated terminal runs `mcode login --region global`.
3. Complete the browser sign-in, then return to VS Code.
4. Open the MiniMax activity-bar panel and send a chat message, or right-click a
   selection to explain, refactor, generate tests, or document it.
5. To let it make code changes, click **Enable agent** (or run **MiniMax: Toggle
   Agent Mode**) and ask it to edit the current workspace. Each write opens a
   diff and waits for your approval.

For a mainland-China account, set `minimax.mcode.region` to `cn`. The extension
looks first for the official user installation (`~/.minimax-code/bin/mcode`) and
then for `mcode` on PATH; a workspace cannot override that executable.

## Architecture and limits

The extension starts `mcode acp` locally and exchanges Agent Client Protocol
(ACP) JSON-RPC messages through standard input/output. The MiniMax Code process
owns the account session and sends responses back through ACP; this extension
does not inspect MiniMax Code's data directory, system keychain, tokens, or
cookies. It refuses to operate in an untrusted VS Code workspace.

Before the first chat message and before each selection action, VS Code asks for
confirmation that the relevant content will be sent to MiniMax Code. The panel's
chat transcript exists only in memory for the current VS Code session; it is not
written to workspace state. On activation, it also removes the history written by
earlier versions. Subprocess stderr is intentionally not copied to the
extension output channel because it can contain request details.

ACP exposes an agent chat/session surface, not a standard fill-in-the-middle
completion endpoint. Consequently, this build intentionally does **not** enable
Copilot-style ghost-text completions. It supports chat and selection actions.

## Agent mode and safety boundary

Agent mode is off by default and only lasts for the current VS Code session. It
is available only in a trusted, folder-backed workspace. MiniMax can read files
only inside that workspace; resolved paths and symlinks that lead outside are
rejected. Reads and proposed writes are capped at 1 MB. A write is refused when
the affected editor has unsaved changes, opens a VS Code diff, and requires a
separate **Apply change** click. This prevents the extension from silently
modifying files.

Terminal execution is not implemented or advertised. That means MiniMax cannot
run shell commands, `git commit`, `git push`, or publish anything to GitHub from
this extension. Those actions remain under your control in VS Code/GitHub, rather
than being bundled into file-edit permission.

## Build

```bash
npm install
npm run compile
```

The compiled extension entry point is `out/extension.js`.

## What was removed

The previous implementation contained a custom OAuth/PKCE flow with an assumed
client ID and assumed endpoints. Those values were not a registered public
MiniMax OAuth integration, so they could not safely authenticate a subscription.
They have been removed rather than emulated.
