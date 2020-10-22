# Releasing vscode-woke extension

Run `npm version [major|minor|patch] -m "Bump version %s"` to bump the version on the main branch.

Run `git push && git push --tags` to push the tag.
This will trigger GitHub Actions to publish the new version to the VS Code Marketplace.
