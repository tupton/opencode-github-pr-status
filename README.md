# OpenCode GitHub PR status

Show the current branch's GitHub pull request in the OpenCode terminal prompt.

## Install

```sh
opencode plugin add opencode-github-pr-status@0.4.0
```


### Requirements

- OpenCode V2 2.0.18 or later
- `git`
- the [GitHub CLI](https://cli.github.com/). Sign in to GitHub with `gh auth login` before opening a session in a repository with a pull request.

## Use

Open an OpenCode session on a branch with a GitHub pull request. The prompt footer shows `PR #123`, colored by review and check status. Click the number to open the pull request in your browser.

The plugin also adds two commands: **GitHub PR: Open** and **GitHub PR: Refresh**.

The status automatically refreshes every minute and after a session completes or the branch changes. On a branch without a pull request, the indicator is empty. Refresh errors appear as a toast.

## Develop

Use the Node.js version in `.nvmrc` (currently 26), pnpm 10.34.5, and Bun. Run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm typecheck`. The tests check the files in the npm package and render the built TUI entrypoint from a `node_modules` directory. `npm publish` builds the TUI before packing it. You do not need GitHub credentials to run the tests. The package's `engines` field specifies the minimum supported Node.js version, which may be lower than the development and CI version.

See [RELEASING.md](RELEASING.md) to publish a version.
