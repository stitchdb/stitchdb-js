/** An organization as the signed-in user sees it. */
export type Org = {
  id: string
  name: string
  slug: string | null
  metadata: Record<string, unknown>
  /** The signed-in user's role in it: owner, admin, member or one of your custom roles. */
  role: string
  members: number
  created_at: string
  /** In `list()` only: the user's active organization (the `org_id` claim). */
  active?: boolean
}

export type OrgMember = { user_id: string; email: string | null; name: string | null; role: string; joined_at: string }

export type OrgInvite = {
  id: string
  email: string
  role: string
  expires_at: string
  created_at?: string
  /** Returned by `invite()` only: put it in your own link if you share invites yourself. */
  token?: string
}

export class OrgsError extends Error {
  status: number
  code: string | undefined
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'OrgsError'
    this.status = status
    this.code = code
  }
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any; status?: number }>

/**
 * Organizations (teams, workspaces) for your app's users: create, invite by e-mail, roles.
 * Turn it on in Studio → Authentication → Organizations. Calls the `org_*` database functions;
 * protect your tables with `auth.is_member(org_id)` and `auth.has_role('admin', org_id)`.
 */
export class OrgsClient {
  constructor(
    private rpc: Rpc,
    private refresh: () => Promise<unknown>
  ) {}

  private async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k]
    const { data, error, status } = await this.rpc(fn, args)
    if (error) {
      const missing = error.code === 'PGRST202' || /Could not find the function/i.test(error.message || '')
      throw new OrgsError(
        missing ? 'Organizations are not turned on for this project (Studio → Authentication → Organizations)' : error.message,
        status || 400,
        error.code
      )
    }
    return data as T
  }
  // A new JWT carries the org claims (org_id, org_role, orgs). No session (server side): nothing to refresh.
  private async renew() {
    try {
      await this.refresh()
    } catch {}
  }

  /** Create an organization; the signed-in user becomes its owner. */
  async create(o: { name: string; slug?: string; metadata?: Record<string, unknown> }): Promise<Org> {
    const org = await this.call<Org>('org_create', { name: o.name, slug: o.slug, metadata: o.metadata })
    await this.renew()
    return org
  }
  /** Rename or change slug / metadata (admin). */
  update(org: string, o: { name?: string; slug?: string; metadata?: Record<string, unknown> }): Promise<Org> {
    return this.call('org_update', { org, name: o.name, slug: o.slug, metadata: o.metadata })
  }
  /** Delete the organization with its memberships and invites (owner). */
  async delete(org: string): Promise<void> {
    await this.call('org_delete', { org })
    await this.renew()
  }
  /** The signed-in user's organizations. */
  list(): Promise<Org[]> {
    return this.call('org_list')
  }
  /** Members of an organization (any member can list). */
  members(org: string): Promise<OrgMember[]> {
    return this.call('org_members', { org })
  }
  /** Invite by e-mail (admin). The person gets an e-mail with a link to your app; without `role`, the default role from Settings. */
  invite(org: string, o: { email: string; role?: string }): Promise<OrgInvite> {
    return this.call('org_invite', { org, email: o.email, role: o.role })
  }
  /** Open invites (admin). */
  invites(org: string): Promise<OrgInvite[]> {
    return this.call('org_invites', { org })
  }
  revokeInvite(invite: string): Promise<void> {
    return this.call('org_revoke_invite', { invite })
  }
  /** Accept an invite with the token from the e-mail link. The user must be signed in with the invited address. */
  async acceptInvite(token: string): Promise<Org> {
    const org = await this.call<Org>('org_accept_invite', { token })
    await this.renew()
    return org
  }
  /** Change a member's role (admin; only owners change admins or make owners). */
  setRole(org: string, userId: string, role: string): Promise<void> {
    return this.call('org_set_role', { org, user_id: userId, role })
  }
  /** Remove a member (admin). */
  removeMember(org: string, userId: string): Promise<void> {
    return this.call('org_remove_member', { org, user_id: userId })
  }
  /** Leave an organization. The last owner must transfer ownership or delete it first. */
  async leave(org: string): Promise<void> {
    await this.call('org_leave', { org })
    await this.renew()
  }
  /** Make another member the owner; you become admin (owner). */
  transferOwnership(org: string, userId: string): Promise<void> {
    return this.call('org_transfer_ownership', { org, user_id: userId })
  }
  /** Switch the active organization and refresh the session, so the JWT's `org_id` and `org_role` are for it. */
  async setActive(org: string): Promise<void> {
    await this.call('org_set_active', { org })
    await this.renew()
  }
}
