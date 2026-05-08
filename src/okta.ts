import { request } from "undici";
import { parseNextLink } from "./http";

export interface OktaUser {
  id: string;
  status: string;
  profile: {
    email?: string;
    login?: string;
    secondEmail?: string;
  };
}

export interface OktaGroup {
  id: string;
  profile?: { name?: string };
}

export class OktaClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(domain: string, token: string) {
    const cleaned = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.baseUrl = `https://${cleaned}`;
    this.token = token;
  }

  async listGroupMembers(groupId: string): Promise<OktaUser[]> {
    const users: OktaUser[] = [];
    let url: string | null = `${this.baseUrl}/api/v1/groups/${encodeURIComponent(groupId)}/users?limit=200`;

    while (url) {
      const res = await request(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `SSWS ${this.token}`,
        },
      });

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const body = await res.body.text();
        throw new Error(
          `Okta API error ${res.statusCode} for group ${groupId}: ${body.slice(0, 500)}`
        );
      }

      const batch = (await res.body.json()) as OktaUser[];
      users.push(...batch);

      url = parseNextLink(res.headers["link"]);
    }

    return users;
  }

  async findUserByEmail(email: string): Promise<OktaUser | null> {
    const search = `profile.email eq "${email}" or profile.login eq "${email}" or profile.secondEmail eq "${email}"`;
    const url = `${this.baseUrl}/api/v1/users?limit=1&search=${encodeURIComponent(search)}`;
    const res = await request(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `SSWS ${this.token}`,
      },
    });
    if (res.statusCode === 404) return null;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`Okta search error ${res.statusCode}: ${body.slice(0, 500)}`);
    }
    const users = (await res.body.json()) as OktaUser[];
    return users[0] ?? null;
  }

  async listUserGroups(userId: string): Promise<OktaGroup[]> {
    const url = `${this.baseUrl}/api/v1/users/${encodeURIComponent(userId)}/groups`;
    const res = await request(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `SSWS ${this.token}`,
      },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`Okta listUserGroups error ${res.statusCode}: ${body.slice(0, 500)}`);
    }
    return (await res.body.json()) as OktaGroup[];
  }

  async isInAnyGroup(emails: string[], groupIds: Set<string>): Promise<boolean> {
    for (const email of emails) {
      const user = await this.findUserByEmail(email);
      if (!user) continue;
      if (user.status && user.status.toUpperCase() === "DEPROVISIONED") continue;
      const groups = await this.listUserGroups(user.id);
      if (groups.some((g) => groupIds.has(g.id))) return true;
    }
    return false;
  }

  async collectEmails(groupIds: string[]): Promise<{
    emails: Set<string>;
    perGroup: Map<string, number>;
  }> {
    const emails = new Set<string>();
    const perGroup = new Map<string, number>();
    for (const groupId of groupIds) {
      const members = await this.listGroupMembers(groupId);
      perGroup.set(groupId, members.length);
      for (const u of members) {
        if (u.status && u.status.toUpperCase() === "DEPROVISIONED") continue;
        const candidates = [u.profile?.email, u.profile?.login, u.profile?.secondEmail];
        for (const e of candidates) {
          if (e && e.includes("@")) emails.add(e.trim().toLowerCase());
        }
      }
    }
    return { emails, perGroup };
  }
}