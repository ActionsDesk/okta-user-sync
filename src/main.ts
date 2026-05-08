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
    const oktaAppId = core.getInput("okta-app-id", { required: true });
    const dryRun = (core.getInput("dry-run") || "true").toLowerCase() !== "false";
    const domainFilter = new Set(
      parseList(core.getInput("email-domain-filter") || "").map((s) => s.toLowerCase())
    );

    core.info(`Mode: ${dryRun ? "DRY-RUN" : "ENFORCE"}`);
    core.info(`Enterprise: ${enterprise}`);
    core.info(`Okta app: ${oktaAppId}`);
    if (domainFilter.size > 0) {
      core.info(`Email domain filter: ${[...domainFilter].join(", ")}`);
    }

    const github = new GitHubClient(githubToken);
    const okta = new OktaClient(oktaDomain, oktaToken);

    core.startGroup("Fetching Okta app assignments");
    const appUsers = await okta.listAppUsers(oktaAppId);
    const oktaEmails = okta.collectEmails(appUsers);
    core.info(`App-assigned users: ${appUsers.length}`);
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
      core.startGroup("Drift protection: re-fetching Okta app assignments before removals");
      const refreshedAppUsers = await okta.listAppUsers(oktaAppId);
      const refreshedEmails = okta.collectEmails(refreshedAppUsers);
      core.info(`Refreshed Okta unique emails: ${refreshedEmails.size}`);
      core.endGroup();

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

        if (filtered.some((e) => refreshedEmails.has(e))) {
          driftSpared.push(login);
          core.info(`Skipping ${login}: appeared in refreshed Okta app snapshot`);
          continue;
        }

        try {
          if (await okta.hasAnyEmailAssignedToApp(oktaAppId, filtered)) {
            driftSpared.push(login);
            core.info(`Skipping ${login}: per-user Okta re-check found app assignment`);
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
      .addRaw(`Okta app: \`${oktaAppId}\``)
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
