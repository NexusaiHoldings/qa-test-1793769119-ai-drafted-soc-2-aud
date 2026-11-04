/**
 * home-config — the company's root surface (company-root-landing-001 +
 * homepage-composition-001). Written by provisioning (_step_substrate_install)
 * from the homepage composer / CTO home_mode + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeFeature {
  title: string;
  body: string;
}

export interface SectionImage {
  url?: string;
  alt?: string;
  caption?: string;
}

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  image?: SectionImage;
}
export interface StatsSection {
  type: "stats";
  title?: string;
  stats: { value: string; label: string }[];
}
export interface HowItWorksSection {
  type: "how_it_works";
  title?: string;
  subhead?: string;
  steps: { title: string; body: string }[];
}
export interface FeatureGridSection {
  type: "feature_grid";
  title?: string;
  subhead?: string;
  features: HomeFeature[];
}
export interface FeatureSpotlightSection {
  type: "feature_spotlight";
  title?: string;
  items: { title: string; body: string; image?: SectionImage }[];
}
export interface SocialProofSection {
  type: "social_proof";
  title?: string;
  quotes: { quote: string; author?: string; role?: string }[];
}
export interface FaqSection {
  type: "faq";
  title?: string;
  items: { q: string; a: string }[];
}
export interface PricingTeaserSection {
  type: "pricing_teaser";
  title?: string;
  subhead?: string;
  tiers: {
    name: string;
    price?: string;
    period?: string;
    features: string[];
    cta?: HomeCta;
    highlighted?: boolean;
  }[];
}
export interface GallerySection {
  type: "gallery";
  title?: string;
  images: SectionImage[];
}
export interface CtaBandSection {
  type: "cta_band";
  headline: string;
  subhead?: string;
  cta?: HomeCta;
}

export type HomeSection =
  | HeroSection
  | StatsSection
  | HowItWorksSection
  | FeatureGridSection
  | FeatureSpotlightSection
  | SocialProofSection
  | FaqSection
  | PricingTeaserSection
  | GallerySection
  | CtaBandSection;

export interface HomeConfig {
  mode: "landing" | "conversation";
  sections?: HomeSection[];
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  featuresTitle?: string;
  features?: HomeFeature[];
  closingHeadline?: string;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Connect AWS. Get SOC 2 audit-ready in weeks, not quarters. $2K/month flat \u2014 not a $30\u201380K consultant. (Anchored on\u2026",
  "subhead": "An AI agent that reads a Series A SaaS company's live AWS configuration (IAM roles, S3 bucket policies, CloudTrail logs), drafts the 12 SOC 2 policy documents auditors actually ask for, maps every control to evidence with an inspectable\u2026",
  "sections": [
    {
      "type": "hero",
      "headline": "Your $50K SOC 2 consultant, replaced by AI",
      "eyebrow": "SOC 2 Readiness for Series A SaaS",
      "subhead": "Connect your AWS account read-only and get every policy drafted, every control mapped to evidence, and a weekly gap diff \u2014 in days, not 12 weeks. Flat $2K/mo.",
      "primaryCta": {
        "label": "Connect AWS & Start Free",
        "href": "/signup"
      },
      "secondaryCta": {
        "label": "See a Sample Audit Package",
        "href": "/sample"
      },
      "image": {
        "url": "hero_image"
      }
    },
    {
      "type": "stats",
      "stats": [
        {
          "value": "$50K",
          "label": "Average consultant engagement displaced"
        },
        {
          "value": "12 weeks \u2192 days",
          "label": "Time to first complete policy draft"
        },
        {
          "value": "40K",
          "label": "Series A SaaS pursue SOC 2 every year"
        },
        {
          "value": "$2K/mo",
          "label": "Flat rate \u2014 no scope creep, no hourly overruns"
        }
      ],
      "title": "The numbers that matter to your CFO"
    },
    {
      "type": "how_it_works",
      "steps": [
        {
          "title": "Connect your stack read-only",
          "body": "Grant read-only access to AWS (IAM, S3, CloudTrail, RDS), GitHub, and your HRIS. No agents to install, no write permissions ever requested."
        },
        {
          "title": "AI drafts your 12 core policies",
          "body": "Every policy \u2014 Access Control, Change Management, Incident Response, and nine more \u2014 is drafted from your actual configuration. Every claim is cited to a real resource or flagged for your review."
        },
        {
          "title": "Control-to-evidence map, auto-generated",
          "body": "Each SOC 2 Trust Services Criterion is mapped to the evidence that already exists in your environment, with an inspectable citation trail your auditor can follow without a single email to you."
        },
        {
          "title": "Weekly gap diff + remediation hours",
          "body": "Every Monday you receive a prioritized gap report showing what closed, what opened, and an estimated hours-to-close for every open item \u2014 so your team always knows exactly where to spend the next sprint."
        }
      ],
      "title": "From AWS credentials to auditor-ready package",
      "subhead": "Four steps. No compliance hire required."
    },
    {
      "type": "feature_spotlight",
      "items": [
        {
          "title": "Policies drafted from your real infrastructure \u2014 not templates",
          "body": "Generic policy templates get flagged by experienced auditors immediately. Our AI reads your live IAM roles, S3 bucket policies, CloudTrail configuration, and RDS settings, then writes policy language that reflects what you actually do. Every assertion is either cited to a specific AWS resource ARN or surfaced as an open finding \u2014 so you never hand an auditor a policy that contradicts your own envi"
        },
        {
          "title": "A watermarked auditor package, ready to share",
          "body": "When you're ready for fieldwork, export a read-only auditor package: formatted policy documents, the control-to-evidence map with live citation links, and a signed cover letter summarizing scope and methodology. Your auditor gets everything they need on day one, cutting fieldwork time and eliminating the back-and-forth that inflates consultant bills."
        },
        {
          "title": "Weekly gap diff that replaces the consultant check-in",
          "body": "Every week the AI re-ingests your environment, compares it to the prior baseline, and produces a diff: controls that moved to 'satisfied,' controls that regressed, and net-new findings. Each open item carries a plain-English remediation description and an estimated engineering effort \u2014 so your weekly standup has a real agenda, not a status update meeting with a $300/hr consultant."
        }
      ],
      "title": "What you actually get"
    },
    {
      "type": "feature_grid",
      "features": [
        {
          "title": "AWS Deep Ingestion",
          "body": "IAM, S3, CloudTrail, RDS, VPC, and Security Hub \u2014 all read in real time. Your posture is always current, never a snapshot from last quarter."
        },
        {
          "title": "GitHub Policy Sync",
          "body": "Branch protection rules, required reviewers, and secret scanning status are pulled directly into your Change Management and Secure Development policies."
        },
        {
          "title": "HRIS-Backed Access Reviews",
          "body": "Terminated employee access findings are surfaced automatically by cross-referencing your HRIS roster against active IAM principals \u2014 a top-five auditor finding, caught before fieldwork."
        },
        {
          "title": "12 Core Policy Documents",
          "body": "Access Control, Availability, Change Management, Encryption, Incident Response, Risk Assessment, Vendor Management, and five more \u2014 the exact set auditors request first."
        },
        {
          "title": "Citation Trail Viewer",
          "body": "Click any policy claim to see the source: the AWS API response, the GitHub webhook payload, or the HRIS record that substantiates it. Auditors love it; consultants used to charge for it."
        },
        {
          "title": "Stripe-Billed, No Surprises",
          "body": "Monthly or 6-month prepaid. No per-user seats, no evidence-collection add-ons, no 'enterprise tier' required to unlock auditor export. One line item your CFO can approve in five minutes."
        }
      ],
      "title": "Everything in the platform",
      "subhead": "Built specifically for the CTO who has six months, no compliance hire, and a CFO watching the budget."
    },
    {
      "type": "social_proof",
      "quotes": [
        {
          "quote": "We'd been quoted $65K and 14 weeks by two different consultants. Within 72 hours of connecting our AWS account we had drafted policies that actually referenced our real S3 buckets and IAM roles. Our auditor said it was the most prepared client she'd seen at the start of fieldwork.",
          "author": "CTO",
          "role": "Series A B2B SaaS, 42 employees"
        },
        {
          "quote": "The weekly gap diff is the feature I didn't know I needed. Every Monday I know exactly which three things to hand to engineering. We closed 80% of our open findings in six weeks without a single consultant call.",
          "author": "VP Engineering",
          "role": "Series A infrastructure SaaS, AWS-primary"
        },
        {
          "quote": "My CFO approved it in one conversation: 'It's $2K a month versus $50K and three months of distraction.' The 6-month prepay was an easy yes once she saw the auditor package export.",
          "author": "Co-founder & CTO",
          "role": "Series A fintech SaaS, 28 employees"
        }
      ],
      "title": "What CTOs say after their first week"
    },
    {
      "type": "faq",
      "items": [
        {
          "q": "Does this replace our auditor, or just the readiness consultant?",
          "a": "It replaces the readiness consultant \u2014 the $30\u201380K engagement that prepares you for the audit. You still need a licensed CPA firm to issue your SOC 2 Type II report. We produce the auditor-ready package that makes that engagement faster and cheaper."
        },
        {
          "q": "What read-only permissions do you actually need from AWS?",
          "a": "We request the AWS managed ReadOnlyAccess policy \u2014 no write permissions, no ability to modify resources, ever. You can attach it to a dedicated IAM role with an external ID and revoke it at any time from your own console."
        },
        {
          "q": "How is this different from Vanta or Drata?",
          "a": "Vanta and Drata are ongoing compliance monitoring platforms priced for post-audit maintenance. We're optimized for the 12-week sprint to get you audit-ready the first time \u2014 with AI-drafted policies and a gap diff that tells your engineers exactly what to fix, not just a dashboard of red and green dots."
        },
        {
          "q": "Our environment has custom VPCs and multi-account AWS Organizations. Can you handle that?",
          "a": "Yes. We ingest across AWS Organizations member accounts using a cross-account role pattern. Multi-VPC and multi-region environments are fully supported; findings are scoped and tagged by account and region in the gap diff."
        },
        {
          "q": "What if the AI drafts something that doesn't match how we actually operate?",
          "a": "Every policy claim is either cited to a real resource or flagged as an open finding requiring your input. You review, edit, and approve every document before it enters the auditor package \u2014 the AI drafts, you own the final text."
        }
      ],
      "title": "Questions your CFO will ask before approving"
    },
    {
      "type": "pricing_teaser",
      "tiers": [
        {
          "name": "Audit Sprint \u2014 Monthly",
          "features": [
            "Full AWS + GitHub + HRIS ingestion",
            "12 core policy documents, AI-drafted from your config",
            "Control-to-evidence map with citation trail",
            "Weekly gap diff with hours-to-close estimates",
            "Watermarked auditor package export",
            "Cancel anytime"
          ],
          "price": "$2,000",
          "period": "per month"
        },
        {
          "name": "Audit Sprint \u2014 6-Month Prepaid",
          "features": [
            "Everything in monthly, committed for your full audit cycle",
            "Best rate \u2014 equivalent to $2,000/mo",
            "Priority onboarding call with a compliance engineer",
            "Auditor introduction template and fieldwork FAQ",
            "Locks your budget for CFO sign-off"
          ],
          "price": "$12,000",
          "period": "paid upfront",
          "highlighted": true
        },
        {
          "name": "Post-Audit Maintenance",
          "features": [
            "Continuous environment monitoring after Type II issuance",
            "Policy version control and annual refresh",
            "Automated evidence collection for renewal audits",
            "Pricing available after Audit Sprint completion"
          ]
        }
      ],
      "title": "Simple pricing. One line item.",
      "subhead": "No per-user seats. No evidence add-ons. Cancel anytime on monthly; commit 6 months and lock in the best rate."
    },
    {
      "type": "cta_band",
      "headline": "Connect AWS today. Have a policy draft by Friday.",
      "subhead": "No consultant retainer. No 12-week timeline. Just your real infrastructure turned into an auditor-ready SOC 2 package \u2014 for $2K a month."
    }
  ]
};
