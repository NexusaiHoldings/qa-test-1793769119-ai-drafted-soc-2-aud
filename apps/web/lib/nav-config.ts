
/**
 * Navigation configuration consumed by the substrate's <TopNav />.
 *
 * Canonical shape — do not change:
 *   - `primary` renders as the flat strip of top-level links.
 *   - `groups` renders as labeled dropdown sections, each with `links`.
 *
 * Entries below cover every feature page in the SOC 2 MVP scope:
 * readiness scan, control library, policy generator, gap engine,
 * cloud/code integrations, auditor evidence export, and the operator
 * admin surfaces (review queue + control library management).
 */

export interface NavLink {
  /** Display text rendered in the nav strip / dropdown. */
  label: string;
  /** App-relative URL the link points to. */
  href: string;
  /** Optional hint shown in dropdown menus beneath the label. */
  description?: string;
}

export interface NavGroup {
  /** Dropdown section label (e.g. "Integrations"). */
  label: string;
  /** Links rendered inside the dropdown. */
  links: NavLink[];
}

export interface NavConfig {
  primary: NavLink[];
  groups: NavGroup[];
}

export const NAV_CONFIG: NavConfig = {
  primary: [
    {
      label: "Home",
      href: "/",
    },
    {
      label: "Readiness Scan",
      href: "/scan",
    },
    {
      label: "Controls",
      href: "/controls",
    },
    {
      label: "Policies",
      href: "/policies",
    },
    {
      label: "Gaps",
      href: "/gaps",
    },
  ],
  groups: [
    {
      label: "Integrations",
      links: [
        {
          label: "AWS",
          href: "/connect/aws",
          description: "Connect a read-only AWS role for evidence collection",
        },
        {
          label: "GitHub",
          href: "/integrations/github",
          description: "Link repositories for change-management evidence",
        },
      ],
    },
    {
      label: "Auditor",
      links: [
        {
          label: "Evidence Packages",
          href: "/export",
          description: "Generate and download auditor-ready evidence bundles",
        },
      ],
    },
    {
      label: "Admin",
      links: [
        {
          label: "Review Queue",
          href: "/admin/review-queue",
          description: "Human approval gate for findings and drafted claims",
        },
        {
          label: "Control Library",
          href: "/admin/control-library",
          description: "Manage SOC 2 control mappings and criteria",
        },
      ],
    },
  ],
};
