# Repository Agent Instructions

## Release versioning

- Before every `git push` to `main`, increment the root `package.json` version by
  one patch (`0.0.1`) and keep `package-lock.json` in sync. `npm version patch
  --no-git-tag-version` does both; do not hand-edit only one of them.
- Do not create a git tag for this. `.github/workflows/docker-publish.yml`
  triggers on `tags: ["v*"]`, so pushing a tag runs the build and publishes a
  versioned Docker image (the `latest` alias is only applied on a branch push).
  Releases are tagged deliberately, not as a side effect of a push.
- If the user explicitly requests a major, minor, or specific version upgrade,
  follow that request instead.
- `cli/package.json` is versioned independently — leave it alone unless the
  change is in `cli/`. Note that building the CLI package syncs the root version
  *from* `cli/package.json`, so a subsequent `cli:pack` will overwrite the root
  version.
- `CHANGELOG.md` is not updated per push. It records public releases (currently
  well behind the package version) and is written when a release is cut.

### What the version is used for

The root version is a human-facing release marker, not a correctness input:

- `/api/version` and `src/shared/constants/config.js` report it to the dashboard;
- `src/lib/db/migrate.js` records it as `appVersion`, but **informational only** —
  schema changes are gated by `SCHEMA_VERSION`, not by the app version;
- Docker image tags come from git tags (`type=semver`), and the image labels use
  `APP_BUILD_VERSION` (the commit SHA), not this field.

So the bump does not need to accompany anything functional. It exists to keep
released builds distinguishable from one another.
