/**
 * Agreement-page composition for the license step.
 *
 * The backend's copyright notice is no longer a standalone document: it
 * OPENS the first agreement page, with the free & open-source announcement
 * blocks and the short usage-telemetry disclosure folded into it as
 * markdown sections (an h4 language label, a bold headline, then the body
 * — separated by `---` rules the rich-text renderer draws as hairlines).
 * The remaining backend documents (the SySL agreement, the full usage-
 * telemetry notice) follow unchanged as their own pages, so the pager
 * still steps through one document per page and agreeing covers all.
 *
 * Composition is a pure function of (docs, locale): the caller exposes it
 * through a computed, so a locale switch recomposes the merged document —
 * re-picking the appended announcement variant and the telemetry wording —
 * live, without refetching anything from the backend.
 */
import { pickAnnouncementVariants, pickTelemetryNotice } from "./announcement";
import type { InstallerLocale } from "./i18n";

/** 一份协议页：标题 + 富文本正文（受限 markdown 方言）。 */
export interface AgreementDoc {
  title: string;
  body: string;
}

/** Joiner between the merged first document's sections; each bare `---`
 *  line renders as a thin horizontal rule (richText.ts). */
const SECTION_JOINER = "\n\n---\n\n";

/**
 * Merge the backend license documents into the displayed agreement pages.
 * docs[0] (the backend's copyright notice) supplies the first page's
 * title and opening body; the FOSS announcement variants and the short
 * telemetry disclosure for `locale` ride along as markdown sections; the
 * rest of `docs` passes through as further pages. An empty input yields
 * no pages.
 */
export function composeAgreementDocs(
  docs: AgreementDoc[],
  locale: InstallerLocale,
): AgreementDoc[] {
  if (docs.length === 0) return [];
  const [copyright, ...rest] = docs;
  const sections: string[] = [copyright.body];
  for (const variant of pickAnnouncementVariants(locale)) {
    sections.push(`### ${variant.label}\n**${variant.title}**\n${variant.body}`);
  }
  const telemetry = pickTelemetryNotice(locale);
  sections.push(
    `### ${telemetry.label}\n**Usage Telemetry / 使用量遥测**\n${telemetry.text}`,
  );
  return [
    { title: copyright.title, body: sections.join(SECTION_JOINER) },
    ...rest,
  ];
}
