# Release a version

## Publish the first version

Trusted publishing requires an existing npm package. To publish `0.1.0` for the first time:

1. Run `npm ci`, `npm test`, and `npm run typecheck` on the commit you plan to release.
2. Sign in to npm locally with `npm login`. Do not put an npm token in this repository or in GitHub secrets.
3. Run `npm publish --access public` from the repository root.
4. In the npm package settings for `opencode-github-pr-status`, add a GitHub Actions trusted publisher. Set the owner to `tupton`, the repository to `opencode-github-pr-status`, and the workflow filename to `publish.yml`. Allow `npm publish` as an action.
5. Tag the published commit `v0.1.0` and push the tag. The publish workflow skips a version that already exists on npm.
6. Confirm that `opencode plugin add opencode-github-pr-status@0.1.0` installs it into `cli.json`, then check the indicator in a session with a pull request.

The first publish might require an npm account verification or one-time password. Complete that prompt in your own terminal; do not share credentials.

## Publish later versions

1. Update `version` in `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version`.
2. Run `npm ci`, `npm test`, and `npm run typecheck`. Merge the version change into the default branch.
3. Tag that commit `v<version>` and push the tag. The `publish.yml` workflow checks that the tag matches `package.json`, then publishes through npm trusted publishing.

The trusted publisher needs a GitHub-hosted runner and the `id-token: write` permission already declared in `publish.yml`.
