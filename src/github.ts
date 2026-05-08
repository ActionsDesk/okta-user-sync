import { request } from "undici";
import { parseNextLink } from "./http";

export interface ConsumedLicenseUser {
  github_com_login: string;
  github_com_name: string;
  github_com_user: boolean;
  enterprise_server_user: boolean;
  license_type: string;
  github_com_enterprise_roles: string[];
  github_com_verified_domain_emails: string[];
  github_com_saml_name_id: string;
  enterprise_server_emails: string[];
}

export interface ConsumedLicensesResponse {
  total_seats_consumed: number;
  total_seats_purchased: number;
  users: ConsumedLicenseUser[];
}

const API_VERSION = "2026-03-10";

export class GitHubClient {
  private readonly token: string;
  private readonly api: string;
  private readonly graphql: string;

  constructor(token: string, apiUrl = "https://api.github.com") {
    this.token = token;
    this.api = apiUrl.replace(/\/+$/, "");
    this.graphql = `${this.api}/graphql`;
  }

  private restHeaders(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "user-agent": "user-sync-okta-action",
      "x-github-api-version": API_VERSION,
    };
  }

  async listConsumedLicenses(enterprise: string): Promise<ConsumedLicenseUser[]> {
    const users: ConsumedLicenseUser[] = [];
    let url: string | null = `${this.api}/enterprises/${encodeURIComponent(
      enterprise
    )}/consumed-licenses?per_page=100`;

    while (url) {
      const res = await request(url, { method: "GET", headers: this.restHeaders() });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const body = await res.body.text();
        throw new Error(
          `GitHub consumed-licenses error ${res.statusCode}: ${body.slice(0, 500)}`
        );
      }
      const json = (await res.body.json()) as ConsumedLicensesResponse;
      users.push(...(json.users ?? []));
      url = parseNextLink(res.headers["link"]);
    }

    return users;
  }

  async getEnterpriseId(slug: string): Promise<string> {
    const data = await this.graphqlRequest<{ enterprise: { id: string } | null }>(
      `query($slug: String!) { enterprise(slug: $slug) { id } }`,
      { slug }
    );
    if (!data.enterprise) {
      throw new Error(`Enterprise not found or token lacks access: ${slug}`);
    }
    return data.enterprise.id;
  }

  async getUserId(login: string): Promise<string | null> {
    try {
      const data = await this.graphqlRequest<{ user: { id: string } | null }>(
        `query($login: String!) { user(login: $login) { id } }`,
        { login }
      );
      return data.user?.id ?? null;
    } catch {
      return null;
    }
  }

  async removeEnterpriseMember(enterpriseId: string, userId: string): Promise<void> {
    await this.graphqlRequest(
      `mutation($input: RemoveEnterpriseMemberInput!) {
         removeEnterpriseMember(input: $input) { clientMutationId }
       }`,
      { input: { enterpriseId, userId } }
    );
  }

  private async graphqlRequest<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const res = await request(this.graphql, {
      method: "POST",
      headers: {
        ...this.restHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.body.json()) as { data?: T; errors?: { message: string }[] };
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`GraphQL HTTP ${res.statusCode}: ${JSON.stringify(body).slice(0, 500)}`);
    }
    if (body.errors && body.errors.length > 0) {
      throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!body.data) throw new Error("GraphQL response missing data");
    return body.data;
  }
}
