import * as core from "@actions/core";
import { GitHubClient, ConsumedLicenseUser } from "./github";
import { OktaClient } from "./okta";

function parseList(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

async function run(): Promise<void> {
  try {
    const enterprise = core.getInput("enterprise", { required: true });
    const githubToken = core.getInput("github-token", { required: true });
    const oktaDomain = core.getInput("okta-domain", { required: true });
    const oktaToken = core.getInput("okta-token", { required: true });
    const oktaGroupsRaw = core.getInput("okta-groups", { required: true });
    const dryRun = (core.getInput("dry-run") || "true").toLowerCase() !== "false";
    const domainFilter = new Set(
      parseList(core.getInput("email-domain-filter") || "").map((s) => s.toLowerCase())
    );

    const oktaGroups = parseList(oktaGroupsRaw);
    if (oktaGroups.length === 0) throw new Error("okta-groups input is empty");

    core.info(`Mode: ${dryRun ? "DRY-RUN" : "ENFORCE"}`);
    core.info(`Enterprise: ${enterprise}`);
    core.info(`Okta groups: ${oktaGroups.join(", ")}`);
    if (domainFilter.size > 0) {
      core.info(`Email domain filter: ${[...domainFilter].join(", ")}`);
    }

    const github = new GitHubClient(githubToken);
    const okta = new OktaClient(oktaDomain, oktaToken);

    core.startGroup("Fetching Okta group members");
    const { emails: oktaEmails, perGroup } = await okta.collectEmails(oktaGroups);
    for (const [g, n] of perGroup) core.info(`  group ${g}: ${n} members`);
    core.info(`Total unique Okta emails: ${oktaEmails.size}`);
    core.endGroup();

    core.startGroup("Fetching GitHub enterprise consumed licenses");
    const ghUsers = await github.listConsumedLicenses(enterprise);
    core.info(`Total enterprise consumed-license entries: ${ghUsers.length}`);
    core.endGroup();

    const candidates: ConsumedLicenseUser[] = ghUsers.filter(
      (u) =>
        u.github_com_user === true && (u.license_type || "").toLowerCase() === "enterprise"
    );
    core.info(`GitHub.com enterprise members evaluated: ${candidates.length}`);

    const missingEmails: ConsumedLicenseUser[] = [];
    const toRemove: ConsumedLicenseUser[] = [];
    const matched: string[] = [];

    for (const user of candidates) {
      const verified = (user.github_com_verified_domain_emails ?? []).map((e) =>
        e.toLowerCase()
      );
      const filtered =
        domainFilter.size > 0
          ? verified.filter((e) => domainFilter.has(emailDomain(e)))
          : verified;

      if (filtered.length === 0) {
        missingEmails.push(user);
        continue;
      }

      const inOkta = filtered.some((e) => oktaEmails.has(e));
      if (inOkta) {
        matched.push(user.github_com_login);
      } else {
        toRemove.push(user);
      }
    }

    core.info(`Matched in Okta: ${matched.length}`);
    core.info(`Candidates to remove: ${toRemove.length}`);

    if (missingEmails.length > 0) {
      core.startGroup(`Users with no usable verified domain emails (${missingEmails.length})`);
      for (const u of missingEmails) {
        core.error(
          `User ${u.github_com_login || "(no login)"} has no verified domain emails matching the filter`
        );
      }
      core.endGroup();
    }

    if (toRemove.length > 0) {
      core.startGroup(`Users to remove (${toRemove.length})`);
      for (const u of toRemove) {
        const emails = (u.github_com_verified_domain_emails ?? []).join(", ") || "(none)";
        core.info(`  - ${u.github_com_login} [${emails}]`);
      }
      core.endGroup();
    }

    const removed: string[] = [];
    const driftSpared: string[] = [];
    if (toRemove.length > 0 && !dryRun) {
      core.startGroup("Drift protection: re-fetching Okta snapshot before removals");
      const refreshed = await okta.collectEmails(oktaGroups);
      core.info(`Refreshed Okta unique emails: ${refreshed.emails.size}`);
      core.endGroup();

      const groupIdSet = new Set(oktaGroups);

      core.startGroup("Removing users from enterprise");
      const enterpriseId = await github.getEnterpriseId(enterprise);
      for (const u of toRemove) {
        const login = u.github_com_login;
        const verified = (u.github_com_verified_domain_emails ?? []).map((e) =>
          e.toLowerCase()
        );
        const filtered =
          domainFilter.size > 0
            ? verified.filter((e) => domainFilter.has(emailDomain(e)))
            : verified;

        if (filtered.some((e) => refreshed.emails.has(e))) {
          driftSpared.push(login);
          core.info(`Skipping ${login}: appeared in refreshed Okta snapshot`);
          continue;
        }

        try {
          const stillMissing = !(await okta.isInAnyGroup(filtered, groupIdSet));
          if (!stillMissing) {
            driftSpared.push(login);
            core.info(`Skipping ${login}: per-user Okta re-check found group membership`);
            continue;
          }
        } catch (err) {
          core.warning(
            `Per-user Okta re-check failed for ${login} (${(err as Error).message}); preserving access and skipping removal`
          );
          driftSpared.push(login);
          continue;
        }

        try {
          const userId = await github.getUserId(login);
          if (!userId) {
            core.warning(`Could not resolve node ID for ${login}; skipping`);
            continue;
          }
          await github.removeEnterpriseMember(enterpriseId, userId);
          removed.push(login);
          core.info(`Removed ${login}`);
        } catch (err) {
          core.error(`Failed to remove ${login}: ${(err as Error).message}`);
        }
      }
      core.endGroup();

      if (driftSpared.length > 0) {
        core.notice(
          `Drift protection spared ${driftSpared.length} user(s) from removal: ${driftSpared.join(", ")}`
        );
      }
    } else if (toRemove.length > 0) {
      core.notice(
        `Dry-run: ${toRemove.length} user(s) would be removed. Re-run with dry-run=false to enforce.`
      );
    }

    const reportedCount = dryRun ? toRemove.length : removed.length;
    const reportedLogins = dryRun ? toRemove.map((u) => u.github_com_login) : removed;
    core.setOutput("removed-count", String(reportedCount));
    core.setOutput("removed-logins", JSON.stringify(reportedLogins));
    core.setOutput("drift-spared-logins", JSON.stringify(driftSpared));

    await core.summary
      .addHeading("Okta → GitHub Enterprise Sync")
      .addRaw(`Mode: **${dryRun ? "DRY-RUN" : "ENFORCE"}**`)
      .addBreak()
      .addRaw(`Enterprise: \`${enterprise}\``)
      .addBreak()
      .addRaw(`Okta unique emails: **${oktaEmails.size}**`)
      .addBreak()
      .addRaw(`GitHub members evaluated: **${candidates.length}**`)
      .addBreak()
      .addRaw(
        `Matched: **${matched.length}** | To remove: **${toRemove.length}** | Missing emails: **${missingEmails.length}**`
      )
      .addBreak()
      .addRaw(`Actually removed: **${removed.length}** | Drift-spared: **${driftSpared.length}**`)
      .write();

    if (missingEmails.length > 0) {
      core.setFailed(
        `${missingEmails.length} enterprise user(s) have no usable verified domain emails; cannot determine Okta membership.`
      );
      return;
    }
  } catch (err) {
    core.setFailed((err as Error).message);
  }
}

void run();
