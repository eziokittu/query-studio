// The canonical list of "X to Y" conversions we build dedicated landing pages for.
//
// Each entry becomes a static page at /tools/query-studio/{slug} that targets the
// exact search phrase (e.g. "mysql to postgresql"), shows a real worked example, and
// links into the interactive Studio. This is the single source of truth used by the
// landing pages, the sitemap and the "Popular conversions" chips — add a pair here
// and it appears everywhere.
import { dialectLabel } from "./databases";

export interface ConversionPair {
  from: string;
  to: string;
}

// Readable, SEO-friendly slug parts (ids like "sqlserver" read better hyphenated).
const SLUG_PART: Record<string, string> = {
  sqlserver: "sql-server",
};

// Shorter display names where the dialect label is verbose for a headline.
const SHORT_LABEL: Record<string, string> = {
  mongodb: "MongoDB",
};

export function conversionShortLabel(id: string): string {
  return SHORT_LABEL[id] ?? dialectLabel(id);
}

function slugPart(id: string): string {
  return SLUG_PART[id] ?? id;
}

export function conversionSlug(from: string, to: string): string {
  return `${slugPart(from)}-to-${slugPart(to)}`;
}

// Ordered roughly by search demand — the pairs developers ask for most.
export const CONVERSION_PAIRS: ConversionPair[] = [
  { from: "mysql", to: "postgresql" },
  { from: "postgresql", to: "mysql" },
  { from: "sqlserver", to: "postgresql" },
  { from: "postgresql", to: "sqlserver" },
  { from: "mysql", to: "sqlserver" },
  { from: "sqlserver", to: "mysql" },
  { from: "mysql", to: "bigquery" },
  { from: "postgresql", to: "snowflake" },
  { from: "bigquery", to: "snowflake" },
  { from: "postgresql", to: "redshift" },
  { from: "db2", to: "postgresql" },
  { from: "sqlite", to: "postgresql" },
  { from: "mysql", to: "mariadb" },
  { from: "mysql", to: "mongodb" },
  { from: "postgresql", to: "mongodb" },
];

export interface Conversion extends ConversionPair {
  slug: string;
  /** e.g. "MySQL to PostgreSQL" */
  title: string;
}

export const CONVERSIONS: Conversion[] = CONVERSION_PAIRS.map((p) => ({
  ...p,
  slug: conversionSlug(p.from, p.to),
  title: `${conversionShortLabel(p.from)} to ${conversionShortLabel(p.to)}`,
}));

const BY_SLUG = new Map(CONVERSIONS.map((c) => [c.slug, c]));

export function getConversion(slug: string): Conversion | undefined {
  return BY_SLUG.get(slug);
}

/** The reverse pair, if we also publish a page for it (for cross-linking). */
export function reverseConversion(c: ConversionPair): Conversion | undefined {
  return BY_SLUG.get(conversionSlug(c.to, c.from));
}
