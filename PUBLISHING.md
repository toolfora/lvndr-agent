# Publishing the agent kit

`agent-kit/` lives in the private app repository (`kasazen/lvndr`) and is published as its own
public repository, `kasazen/lvndr-agent`. Edit it here; publish with the steps below. Run them
from the app repository root unless a step says otherwise.

## 0. Check

```sh
pnpm exec vitest run tests/unit/manifests.test.ts tests/unit/cli.test.ts
claude plugin validate ./agent-kit
```

Bump the version in all five places together (`.claude-plugin/plugin.json`,
`.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `server.json`, `cli/package.json`),
plus `VERSION` in `cli/lvndr.mjs` and `metadata.version` in `skills/lvndr/SKILL.md`, and add a
`CHANGELOG.md` entry. The manifests test fails if they disagree.

## 1. Create the GitHub repository (once)

```sh
gh repo create kasazen/lvndr-agent --public \
  --description "lvndr for AI agents: MCP server, skill, Claude Code/Cursor/Codex plugins and CLI" \
  --homepage https://app-production-559c.up.railway.app/developers
```

## 2. Push the folder

`agent-kit/` must be committed in the app repository first. `git subtree split` makes a branch
whose root is `agent-kit/`, with only the history of that folder:

```sh
git subtree split --prefix=agent-kit -b agent-kit-publish
git push git@github.com:kasazen/lvndr-agent.git agent-kit-publish:main
git branch -D agent-kit-publish
git tag -a v0.1.0 -m "lvndr agent kit 0.1.0" "$(git subtree split --prefix=agent-kit)"   # optional
git push git@github.com:kasazen/lvndr-agent.git v0.1.0                                   # optional
```

Repeat the split and push for every release. Never commit to `kasazen/lvndr-agent` directly, or
the next push is not a fast-forward.

## 3. npm (the `lvndr` CLI)

```sh
cd agent-kit/cli
npm view lvndr name 2>/dev/null && echo "name taken: pick a scoped name such as @kasazen/lvndr"
cp ../LICENSE LICENSE        # ship the license in the tarball; do not commit this copy
npm pack --dry-run           # expect lvndr.mjs, README.md, LICENSE, package.json
npm login
npm publish --access public
rm LICENSE
```

If the name `lvndr` is taken, change `name` in `cli/package.json` and every `npx lvndr` in the
READMEs, skill and the app's help pages.

## 4. Official MCP registry

```sh
brew install mcp-publisher        # or download a release from github.com/modelcontextprotocol/registry
cd agent-kit
mcp-publisher login github
mcp-publisher publish
```

The name `io.github.kasazen/lvndr-agent` needs control of the `kasazen` GitHub namespace. If
`kasazen` is your personal account, the device-flow login above is enough. If `kasazen` is an
**organization**, the device flow currently grants only your personal namespace (registry issue
#1468): you must be an org Owner and log in with a token that can read org membership instead,
`mcp-publisher login github --token <PAT>` (classic PAT with `read:org`, or fine-grained PAT with
Organization permissions > Members > Read-only), or publish from GitHub Actions with OIDC
(<https://modelcontextprotocol.io/registry/github-actions>). Check the listing afterwards:
`curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.kasazen/lvndr-agent"`.

## 5. Claude plugin directory

Submit the GitHub repository `kasazen/lvndr-agent` at <https://claude.ai/directory/manage>
(Anthropic's directory docs: <https://claude.com/docs/directory/publish>; the older
`clau.de/plugin-directory-submission` form is described there as no longer supported). Until it
is listed, users install with `/plugin marketplace add kasazen/lvndr-agent`.

## 6. Cursor marketplace

Submit the repository at <https://cursor.com/marketplace/publish> (docs:
<https://cursor.com/docs/plugins>). There is no confirmation email or status page; follow up at
marketplace-publishing@cursor.com. Optionally also list it on <https://cursor.directory>, a
separate community index with its own queue.

## Not covered

Codex: `codex plugin marketplace add kasazen/lvndr-agent` works from the public repository; public
listing goes through OpenAI's plugin submission portal (<https://developers.openai.com/plugins/deploy/submission>).
