# Auth, super admin & access

> **Summary:** GitHub OAuth through Auth.js v5 (`next-auth@5.0.0-beta.32`) with JWT sessions that carry only
> `userId`. The **first account is the super admin** (`User.isSuperAdmin`), the only role besides "member". The super
> admin manages every instance setting: registration, invite links and SMTP. Registration can be invite-only.

## Files

| Concern | File |
| --- | --- |
| Auth.js config, callbacks, `getCurrentUserOrThrow`, `UnauthorizedError`, `ForbiddenError` | `apps/web/src/lib/auth.ts` |
| Page and action guards | `apps/web/src/server/session.ts` |
| Registration gate | `apps/web/src/server/registration.ts` (`admitGitHubUser`) |
| Invite tokens | `apps/web/src/server/invite-tokens.ts`, `apps/web/src/lib/invites.ts` |
| Invite acceptance page | `apps/web/src/app/invite/[token]/page.tsx` |
| Admin panel | `apps/web/src/app/(dashboard)/admin/layout.tsx` (super admin guard, tabs from `components/admin/admin-nav.tsx`), `admin/page.tsx` (overview) |
| Access settings | `apps/web/src/app/(dashboard)/admin/access/page.tsx`, `server/actions/access.ts`, `server/queries/access.ts`, `components/access/*` |

## Rules

- **MUST** guard every instance-settings page with `await requireSuperAdmin()` (non-admins get a 404) and every
  instance-settings action with `await getSuperAdminOrThrow()` (throws `ForbiddenError`, which `toActionError` maps
  to `FORBIDDEN`).
- **MUST NOT** gate only in the UI. Hiding the sidebar link is cosmetic; the server checks are the security boundary.
- **MUST NOT** put the GitHub token (or anything secret) in the JWT or session. Only `userId` is stored there.
- **MUST** store only `hashInviteToken(token)` (SHA-256). The raw token is returned once by `createInviteAction`.
- New instance-wide settings go on `InstanceSettings` and get a page in the admin panel (`/admin/*`), listed in
  `ADMIN_SECTIONS` (`components/admin/admin-nav.tsx`). The sidebar and the account menu link only to `/admin`
  ([recipes.md](./recipes.md#add-an-instance-setting-super-admin)).

## Sign-in flow

1. `/login` → `signIn("github")` with scope `read:user user:email`.
2. `signIn` callback → `admitGitHubUser(fields, inviteCookie)`:
   - an existing user (by `githubId`) → allowed;
   - `User.count() === 0` → created with `isSuperAdmin: true` (fresh install);
   - an invite cookie with a usable token → one transaction: claim the invite (`updateMany … usedAt: null,
     expiresAt > now`, expect count 1), create the user, set `usedById`. A stale invite falls back to public
     registration, or redirects to `/login?error=InviteInvalid`;
   - otherwise → allowed only if `publicRegistration`, else `/login?error=InviteRequired`.
   - On success the invite cookie is deleted.
3. `jwt` callback (sign-in request only) → upsert the `User` by `githubId` (refreshes profile and encrypted token)
   → `token.userId`.
4. `session` callback → `session.user.id = token.userId`.
5. `getCurrentUserOrThrow()` (React `cache`, once per request) loads the `User` row. A missing row counts as signed
   out.

The email falls back to `<githubId>+<login>@users.noreply.github.com` when GitHub returns none, so `User.email` is
never empty.

## Super admin

- Exactly one in practice: the first account. Migration `20261101120000_invites_registration` made the oldest
  existing account the admin, and `20261101150000_super_admin_smtp_settings` renamed `isAdmin` → `isSuperAdmin`.
- There is no UI to transfer the role. To change it, update the column directly:
  `UPDATE "User" SET "isSuperAdmin" = (id = '<newId>');`
- Pages owned by the super admin: the admin panel, `/admin` (overview), `/admin/access`, `/admin/email` and
  `/admin/history`. The old `/settings/access` and `/settings/email` redirect there (`next.config.ts`).

## Invites

- Constants (`lib/invites.ts`): `INVITE_EXPIRY_DAYS = [1, 7, 30]`, `INVITE_NOTE_MAX_LENGTH = 80`,
  `MAX_PENDING_INVITES = 50`, cookie `repopulse_invite` (httpOnly, `sameSite=lax`, 1 h).
- Status (`inviteStatus`): `pending` | `used` | `expired`. Deleting a pending invite revokes it; deleting a used or
  expired one only clears the list. Accounts are never touched.
- `/invite/<token>` shows who invited you, re-checks the token in its Server Action, sets the cookie and starts GitHub
  sign-in. The atomic claim happens in the `signIn` callback.

## Gotchas

- `trustHost: true` (behind Coolify's proxy). `NEXTAUTH_URL`/`AUTH_URL` must include the scheme, which is why
  compose uses `SERVICE_URL_WEB`.
- `TOKEN_ENCRYPTION_KEY` rotation makes stored GitHub tokens and the SMTP password unreadable. The next sign-in
  re-encrypts the GitHub token; the SMTP password must be re-entered.
