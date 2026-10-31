/** cloudBan — the PURE text assembly for cloud ban-list matches: the
 *  settings list's row tooltip (the "通过云端名单匹配" explanation plus the
 *  ban details the yuyuko answer carried). No Vue / store / transport
 *  here, so the contract is unit-testable in isolation — mirroring
 *  aperadarImport.ts's split. */
import type { CloudBanMatch } from "@/api";

/** Pre-localized label pieces the caller hands in (t() stays at the
 *  component — this module never imports the i18n runtime). */
export interface CloudHintLabels {
  /** The leading "matched via the cloud list" sentence. */
  title: string;
  banTime: string;
  banName: string;
  userName: string;
  namesake: string;
}

/** The tooltip line for one matched player: the cloud-match sentence,
 *  then the first record's details joined, then a (+n) marker when the
 *  answer carried more records (the full history stays one hover away —
 *  the reference viewer lists every record the same way). Records with
 *  nothing readable collapse out; an answer with no records at all
 *  degrades to the bare title. */
export function cloudMatchHint(match: CloudBanMatch, labels: CloudHintLabels): string {
  const parts: string[] = [];
  const first = match.records[0];
  if (first) {
    if (first.banTime) parts.push(`${labels.banTime} ${first.banTime}`);
    if (first.banName) parts.push(`${labels.banName} ${first.banName}`);
    if (first.userName) parts.push(`${labels.userName} ${first.userName}`);
    parts.push(`${labels.namesake} ${first.namesake}`);
  }
  const more = match.records.length > 1 ? ` (+${match.records.length - 1})` : "";
  // Locale-neutral separators: this string renders in every UI locale,
  // and mixed CJK punctuation inside a Latin tooltip reads wrong.
  return parts.length > 0 ? `${labels.title}: ${parts.join(", ")}${more}` : labels.title;
}
