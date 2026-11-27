# Auth, Super Admin & Access

> **Summary:** GitHub OAuth through Better Auth (`better-auth@1.7.28`) with Prisma database sessions. The **first account is the super admin** (`User.isSuperAdmin`), the only role besides "member". The super admin manages every instance setting: registration, invite links, SMTP, the RepoPulse GitHub App, release history settings, and the Dependencies switch. Registration can be invite-only. Writes to users' repositories (update PRs) go through the GitHub App, never the sign-in token.
>
> **Related Docs:** [../apps/web.md](../apps/web.md) · [../packages/db.md](../packages/db.md) · [./dependencies.md](./dependencies.md) · [./recipes.md](./recipes.md)

## Files

| Concern | File |
| --- | --- |
| Better Auth config, database hooks, `getCurrentUserOrThrow`, `UnauthorizedError`, `ForbiddenError` | `apps/web/src/lib/auth.ts` |
| Client auth instance | `apps/web/src/lib/auth-client.ts` |
| Page and action guards | `apps/web/src/server/session.ts` |
| Registration gate | `apps/web/src/server/registration.ts` (`admitNewGitHubUser`) |
| Invite tokens | `apps/web/src/server/invite-tokens.ts`, `apps/web/src/lib/invites.ts` |
| Invite acceptance page | `apps/web/src/app/invite/[token]/page.tsx` |
| Admin panel | `apps/web/src/app/(dashboard)/admin/layout.tsx` (super admin guard, tabs from `components/admin/admin-nav.tsx`), `admin/page.tsx` (overview) |
| Access settings | `apps/web/src/app/(dashboard)/admin/access/page.tsx`, `server/actions/access.ts`, `server/queries/access.ts`, `components/access/*` |
| GitHub App (Admin → GitHub App) | `apps/web/src/app/(dashboard)/admin/github-app/page.tsx`, `server/actions/github-app.ts`, `server/github-app.ts`, `server/queries/github-app.ts`, `lib/github-app*.ts`, `components/admin/github-app-settings.tsx`, `app/api/github-app/manifest/callback/route.ts`; helpers in `packages/github/src/{app,app-hook}.ts`; loader `loadGitHubAppSettings` in `packages/db/src/instance-settings.ts` |
| App webhook route | `apps/web/src/app/api/github-app/webhook/route.ts`, `server/github-app-webhook.ts` |
| Repository permission checks | `apps/web/src/server/queries/dependencies.ts` (`checkRepoAccess`), `apps/deps-worker/src/processors/deps-update.processor.ts` (`hasWriteAccess`) |
| Dependencies switch (Admin → Dependencies) | `apps/web/src/app/(dashboard)/admin/dependencies/page.tsx`, `server/actions/dependencies-admin.ts` (`setDepsEnabledAction`), `server/deps-status.ts` |

## Rules

- **MUST** guard every instance-settings page with `await requireSuperAdmin()` (non-admins get a 404) and every instance-settings action with `await getSuperAdminOrThrow()` (throws `ForbiddenError`, which `toActionError` maps to `FORBIDDEN`).
- **MUST NOT** gate only in the UI. Hiding the sidebar link is cosmetic; the server checks are the security boundary.
- **MUST NOT** put the GitHub token (or anything secret) in the session cookie or JWT. Only the Better Auth database session reference is stored in the cookie; encrypted OAuth tokens live on `User.githubAccessTokenEncrypted`.
- **MUST NOT** return the App private key or webhook secret to the browser (the view exposes only "key saved" / boolean flags), or log installation tokens or JWTs. Store them with `encryptToken`.
- **MUST** check the user's own collaborator permission before any repository access through the App (`getCollaboratorPermission` with the installation token): RepoPulse never takes the installation's word for who may use it.
- **MUST** store only `hashInviteToken(token)` (SHA-256). The raw token is returned once by `createInviteAction`.
- New instance-wide settings go on `InstanceSettings` and get a page in the admin panel (`/admin/*`), listed in `ADMIN_SECTIONS` (`components/admin/admin-nav.tsx`). The sidebar and account menu link only to `/admin` ([recipes.md](./recipes.md#add-an-instance-setting-super-admin)).

## Sign-in flow

1. `/login` → `auth.api.signInSocial({ provider: "github" })` with scope `read:user user:email`.
2. Better Auth OAuth callback (`/api/auth/callback/github`) runs inside a Prisma transaction (`AsyncLocalStorage` + `transaction: true`):
   - Existing users (matched by `Account` `(providerId, accountId)`) sign in directly and refresh profile/`githubLogin` + encrypted token.
   - New users run `databaseHooks.user.create.before` → `admitNewGitHubUser(inviteCookie, tx)`:
     - `User.count() === 0` → admitted with `isSuperAdmin: true` (fresh install, under `pg_advisory_xact_lock`).
     - An invite cookie with a usable token → atomically claims the invite (`updateMany … usedAt: null, expiresAt > now`, expect count 1) and links `usedById` on `account.create.before` (stale invites fall back to public registration or redirect to `/login?error=InviteInvalid`).
     - Otherwise → allowed only if `publicRegistration`, else `/login?error=InviteRequired`.
3. `databaseHooks.account.create.before` / `update` encrypts the GitHub token onto `User.githubAccessTokenEncrypted` and clears plaintext tokens from `Account`.
4. `getCurrentUserOrThrow()` (React `cache`, once per request) reads `auth.api.getSession({ headers })` and loads the `User` row (with `omit: { githubAccessTokenEncrypted: false }`). A missing row counts as signed out.

The email falls back to `<githubId>+<login>@users.noreply.github.com` when GitHub returns none, so `User.email` is never empty.

## Super admin

Bootstrap registration takes a PostgreSQL transaction advisory lock before checking whether the instance is empty and creating its first super admin. Concurrent initial callbacks recheck after the winning transaction commits and then follow ordinary registration/invite rules.

- Exactly one in practice: the first account. Migration `20261101120000_invites_registration` made the oldest existing account admin, and `20261101150000_super_admin_smtp_settings` renamed `isAdmin` → `isSuperAdmin`.
- There is no UI to transfer the role. To change it, update the column directly:
  `UPDATE "User" SET "isSuperAdmin" = (id = '<newId>');`
- Pages owned by the super admin: `/admin` (overview), `/admin/access`, `/admin/email`, `/admin/history`, `/admin/github-app`, and `/admin/dependencies`. Legacy `/settings/access` and `/settings/email` redirect there (`next.config.ts`).

## Invites

- Constants (`lib/invites.ts`): `INVITE_EXPIRY_DAYS = [1, 7, 30]`, `INVITE_NOTE_MAX_LENGTH = 80`, `MAX_PENDING_INVITES = 50`, cookie `repopulse_invite` (`httpOnly`, `sameSite=lax`, 1 h).
- Status (`inviteStatus`): `pending` | `used` | `expired`. Deleting a pending invite revokes it; deleting a used or expired one only clears the list. Accounts are never touched.
- `/invite/<token>` shows who invited you, re-checks the token in its Server Action, sets the cookie, and starts GitHub sign-in. The atomic claim happens in the `signIn` callback.

## GitHub App (Dependencies)

The App gives scoped write access (`contents` + `pull_requests`), short-lived tokens, and bot-authored commits, and lets RepoPulse read private repositories. Sign-in scopes stay `read:user user:email`. Stored on `InstanceSettings` (`githubAppId`, `githubAppSlug`, `githubAppClientId`, `githubAppOwner`, encrypted key and webhook secret); configured when id, slug, and key are set. Every process reads it per use, so changes apply without a restart.

- **Manifest flow** (preferred): `startGitHubAppManifestAction` (super admin; optional organization and name) sets the state cookie `repopulse_github_app_state` (random, `httpOnly`, `sameSite=lax`, `secure` in production, path `/api/github-app/manifest`, 10 minutes) and returns the form target (`/settings/apps/new` or `/organizations/<org>/settings/apps/new`) plus the manifest: name `RepoPulse (<host>)`, `public: true`, permissions `metadata: read`, `contents: write`, `pull_requests: write`, no events, webhook inactive, callback `<base>/api/github-app/manifest/callback`, setup URL `<base>/dependencies?installed=1`. Base URL comes from `APP_BASE_URL` (falling back to `AUTH_URL`).
- **Callback** `GET /api/github-app/manifest/callback` (super admin, 404 for others): compares `state` with the cookie in constant time, clears the cookie, exchanges the code (`POST /app-manifests/{code}/conversions`), stores the App encrypted, and redirects to `/admin/github-app?created=1`, or `?error=state|code|conversion|rate_limited|unknown` (fixed codes only). Because the cookie is `secure` in production, a production instance served over plain `http` always ends with `?error=state`.
- **Manual form** (existing App, GitHub Enterprise-like setups): `saveGitHubAppSettingsAction` validates id + PEM by signing a JWT and calling `GET /app` (the slug must match GitHub's); optional webhook secret. `removeGitHubAppSettingsAction` clears every column. Both use `getSuperAdminOrThrow()`.
- **Installation**: users install the App per repository (`installUrl`; pre-selects the repository only together with the owner's account id). Nothing trusts the setup redirect: the next scan or page render discovers the installation per repository (`GET /repos/{o}/{r}/installation`). `/dependencies?installed=1` shows a notice.
- **Tokens**: `createInstallationToken` narrows each token to one repository and the needed permissions (`contents: read` + `pull_requests: read` for scans, `contents: write` + `pull_requests: write` for updates, `metadata: read` for web checks). `deps-worker` caches them in memory until 5 minutes before expiry.
- **Permission checks** (`User.githubLogin` cache; on a 404 it is re-resolved from `githubId` with `GET /user/{id}` and saved): adding a private repository needs `read`+; choosing a PR mode, "Create PR", and **every** `deps-update` job need `write` / `maintain` / `admin`. Every scan of a private repository re-checks `read`. A project whose owner lost access falls back to `NOTIFY`, releases PR ownership, and the owner is notified.
- **Webhooks** (optional): "Enable webhooks" (`enableGitHubAppWebhooksAction`, only for a public `https://` `APP_BASE_URL`) points the App hook at `<base>/api/github-app/webhook` with the saved secret (or a new random one via "Replace the secret"), stored only after GitHub accepts it. GitHub's API cannot activate the hook or subscribe to events, so the UI lists the manual steps (tick "Active", Push, and Pull request events). See [../CONTRACTS.md](../CONTRACTS.md#github-app-webhook-contract).
- **Admin → Dependencies**: `setDepsEnabledAction` (super admin) flips `InstanceSettings.depsEnabled`; the page shows the `deps-worker` heartbeat, sandbox tool versions, App state, and instance-wide counts.

## Gotchas

- `trustHost: true` (behind Coolify's proxy). `NEXTAUTH_URL` / `AUTH_URL` must include the scheme, which is why Compose uses `SERVICE_URL_WEB`.
- `TOKEN_ENCRYPTION_KEY` rotation makes stored GitHub tokens, the SMTP password, and the GitHub App key / webhook secret unreadable. The next sign-in re-encrypts the GitHub token; the SMTP password and App key must be re-entered (`GitHubAppKeyUnreadableError`, `SmtpPasswordUnreadableError`).
