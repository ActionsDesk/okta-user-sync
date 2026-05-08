import { request } from "undici";
import { parseNextLink } from "./http";

export interface OktaAppUser {
  id: string;
  status: string;
  credentials?: {
    userName?: string;
  };
  profile?: {
    email?: string;
    userName?: string;
    login?: string;
    secondEmail?: string;
  };
}

export class OktaClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(domain: string, token: string) {
    const cleaned = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.baseUrl = `https://${cleaned}`;
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `SSWS ${this.token}`,
    };
  }

  async listAppUsers(appId: string): Promise<OktaAppUser[]> {
    const users: OktaAppUser[] = [];
    let url: string | null = `${this.baseUrl}/api/v1/apps/${encodeURIComponent(appId)}/users?limit=500`;

    while (url) {
      const res = await request(url, { method: "GET", headers: this.headers() });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const body = await res.body.text();
        throw new Error(
          `Okta API error ${res.statusCode} listing app ${appId} users: ${body.slice(0, 500)}`
        );
      }
      const batch = (await res.body.json()) as OktaAppUser[];
      users.push(...batch);
      url = parseNextLink(res.headers["link"]);
    }
    return users;
  }

  collectEmails(users: OktaAppUser[]): Set<string> {
    const emails = new Set<string>();
    for (const u of users) {
      if (u.status && u.status.toUpperCase() === "DEPROVISIONED") continue;
      const candidates = [
        u.profile?.email,
        u.profile?.userName,
        u.profile?.login,
        u.profile?.secondEmail,
        u.credentials?.userName,
      ];
      for (const e of candidates) {
        if (e && e.includes("@")) emails.add(e.trim().toLowerCase());
      }
    }
    return emails;
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    const search = `profile.email eq "${email}" or profile.login eq "${email}" or profile.secondEmail eq "${email}"`;
    const url = `${this.baseUrl}/api/v1/users?limit=1&search=${encodeURIComponent(search)}`;
    const res = await request(url, { method: "GET", headers: this.headers() });
    if (res.statusCode === 404) return null;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`Okta search error ${res.statusCode}: ${body.slice(0, 500)}`);
    }
    const users = (await res.body.json()) as Array<{ id: string; status?: string }>;
    const user = users[0];
    if (!user) return null;
    if (user.status && user.status.toUpperCase() === "DEPROVISIONED") return null;
    return user.id;
  }

  async isUserAssignedToApp(appId: string, userId: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(userId)}`;
    const res = await request(url, { method: "GET", headers: this.headers() });
    if (res.statusCode === 404) return false;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(
        `Okta app-user check error ${res.statusCode} for ${userId}: ${body.slice(0, 500)}`
      );
    }
    const appUser = (await res.body.json()) as OktaAppUser;
    if (appUser.status && appUser.status.toUpperCase() === "DEPROVISIONED") return false;
    return true;
  }

  async hasAnyEmailAssignedToApp(appId: string, emails: string[]): Promise<boolean> {
    for (const email of emails) {
      const userId = await this.findUserIdByEmail(email);
      if (!userId) continue;
      if (await this.isUserAssignedToApp(appId, userId)) return true;
    }
    return false;
  }
}
