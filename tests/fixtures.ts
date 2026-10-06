export const catalog = {
  organizations: [{ id: "org_demo" }, { id: "org_other" }],
  projects: [{ id: "project_demo", organizationId: "org_demo" }],
  applications: [
    { id: "app_demo", organizationId: "org_demo", projectId: "project_demo" },
    { id: "app_other", organizationId: "org_demo", projectId: "project_demo" },
  ],
  flavors: [
    { id: "free", organizationId: "org_demo", applicationId: "app_demo" },
    { id: "pro", organizationId: "org_demo", applicationId: "app_demo" },
    { id: "other", organizationId: "org_demo", applicationId: "app_other" },
  ],
  environments: [
    { id: "production", organizationId: "org_demo", applicationId: "app_demo" },
    { id: "staging", organizationId: "org_demo", applicationId: "app_demo" },
  ],
};
export const target = {
  id: "target_demo",
  organizationId: "org_demo",
  projectId: "project_demo",
  applicationId: "app_demo",
  flavorId: "free",
  environmentId: "production",
  platform: "ios" as const,
};
export const source = {
  id: "source_demo",
  organizationId: "org_demo",
  applicationId: "app_demo",
  repositoryId: "repo_demo",
  commitSha: "a".repeat(40),
  rootDirectory: "apps/demo",
  lockfileDigest: "b".repeat(64),
  adapterId: "expo",
  adapterVersion: "1.0.0",
  toolchain: { node: "24.19.0" },
};
