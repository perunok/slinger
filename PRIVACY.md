# Privacy policy

Slinger is a local-first API client. It has no account requirement, no telemetry, no analytics and no crash reporting.
Your workspaces, collections, environments and history stay in a SQLite file on your computer; secret values stay in the
operating system keychain (see [Where your data lives](README.md#where-your-data-lives)).

## What Slinger sends over the network

Slinger only connects to other systems in these cases:

| When | Where | What is sent | How to turn it off |
| --- | --- | --- | --- |
| You send a request, run a collection or a workflow, or a script calls `pm.sendRequest` | The URL in the request | The request as you wrote it | Don't send it |
| **Update check**: at every start and once a day, while **Check for new releases automatically** is on; or when you choose Help > Check for Updates… | `api.github.com` (the public GitHub API for `perunok/slinger` releases) | A plain HTTPS request for the latest release, which (like any web request) carries your IP address and Slinger's version in the user agent. No data from your workspaces | Settings > Updates > untick **Check for new releases automatically** |
| You click **Update now** | `github.com` / GitHub's download servers | A download request for the installer | Don't click it |
| You sign in to and link a workspace with a **Slinger Cloud** server | The server address you entered | The linked workspaces' content (never secret values), your device name and sign-in tokens | Don't sign in, or unlink the workspace |
| You get an OAuth 2.0 token, import OpenAPI from a URL, or connect an MCP request to a server | The URLs you entered | What that step needs | Don't use the feature |

Slinger also opens a few **local** listeners on `127.0.0.1` only, never on the network: the MCP server for AI assistants (off
by default, Settings > AI assistants), mock servers you start, and the temporary OAuth 2.0 redirect listener.

Links such as the user guide, release notes on GitHub or "Report an issue" open in your browser, which applies its own
privacy settings.

## Third parties

The update check and update downloads are served by GitHub ([GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).
A Slinger Cloud server is run by whoever hosts it; ask them for their policy. No other third-party service is contacted.

## Contact

Questions: open an issue at <https://github.com/perunok/slinger/issues>.
