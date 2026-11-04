export type NavLink = {
  label: string;
  href: string;
  // Optional flag read by the substrate <TopNav /> to gate operator/admin-only
  // routes behind an admin session. Absent/false on public links.
  adminOnly?: boolean;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { label: "Home", href: "/" },
    { label: "Readiness Scan", href: "/scan" },
    { label: "Controls", href: "/controls" },
    { label: "Policies", href: "/policies" },
    { label: "Gaps", href: "/gaps" },
  ],
  groups: [
    {
      label: "Integrations",
      links: [
        { label: "AWS", href: "/connect/aws" },
        { label: "GitHub", href: "/integrations/github" },
      ],
    },
    {
      label: "Auditor",
      links: [{ label: "Evidence Packages", href: "/export" }],
    },
    {
      label: "Admin",
      links: [
        { label: "Review Queue", href: "/admin/review-queue" },
        { label: "Control Library", href: "/admin/control-library" },
      ],
    },
  ],
};
