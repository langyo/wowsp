/**
 * ClanCard — clan overview card, the clan-mode counterpart of StatsCard:
 *   ┌─ identity: [TAG] name + realm ─
 *   ├─ hero: clan-wide aggregate winrate + avg PR (both color-coded)
 *   ├─ KPI grid: members / avg damage / hidden profiles / created
 *   └─ roster table: name (→ player lookup) / role / battles / WR / PR /
 *      avg dmg — numeric columns are sortable (desc → asc → role default).
 *
 * All deep stats come from the same single batched account/info sweep the
 * backend already makes; no extra requests per member (per-ship tables stay
 * on the player page — they would cost one WG request per member).
 */
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type PropType,
} from "vue";

import { HTag } from "@celestia-island/hikari";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp } from "@lucide/vue";

import IdentityHead from "@/components/stats/IdentityHead";
import type { ClanInfo, ClanMember } from "@/api";
import { t } from "@/i18n";
import { prTier, winrateColor } from "@/utils/winrate";
import "./ClanCard.scss";

/** Roster sort keys; null = role-ordered default (officers, battles desc). */
type SortKey = "battles" | "winrate" | "pr" | "avgDamage";

/** Officer roles float to the top of the default roster order. */
const ROLE_ORDER = [
  "commander",
  "executive_officer",
  "recruitment_officer",
  "commissioned_officer",
  "officer",
  "personnel_officer",
  "intelligence_officer",
  "quartermaster",
  "junior_officer",
];

function roleRank(role: string): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

function roleLabel(role: string): string {
  const key = `lookup.role.${role}`;
  const label = t(key);
  // vue-i18n returns the key itself for missing entries — fall back to the
  // raw WG role string.
  return label === key ? role : label;
}

/** Numeric sort value for the active sort key; missing values and hidden
 *  members are sink-handled by the comparator (a fixed -Infinity direction
 *  would float them in asc order). */
function sortValue(m: ClanMember, key: SortKey): number {
  switch (key) {
    case "battles":
      return m.stats.battles ?? Number.NEGATIVE_INFINITY;
    case "winrate":
      return m.stats.winrate ?? Number.NEGATIVE_INFINITY;
    case "pr":
      return m.stats.pr ?? Number.NEGATIVE_INFINITY;
    case "avgDamage":
      return m.stats.avgDamage ?? Number.NEGATIVE_INFINITY;
  }
}

export default defineComponent({
  name: "ClanCard",
  props: {
    clan: { type: Object as () => ClanInfo, required: true },
    /** Roster row clicked → jump to that player's lookup. */
    onMemberClick: Function as PropType<(member: ClanMember) => void>,
  },
  setup(props) {
    const sortKey = ref<SortKey | null>(null);
    const sortDir = ref<"desc" | "asc">("desc");

    // Description collapse: clamped to 6 lines with a fade-out mask by
    // default; the toggle only renders when the text actually overflows.
    // Overflow can't be derived from the text (pre-line wrapping depends on
    // width), so measure the clamped element; the ResizeObserver re-measures
    // on layout/font changes. Expanded state skips measuring — the guard
    // keeps the flag from being cleared by the observer while unfolded.
    const descEl = ref<HTMLParagraphElement | null>(null);
    const descOverflow = ref(false);
    const descExpanded = ref(false);

    function measureDesc() {
      const el = descEl.value;
      if (!el || descExpanded.value) return;
      descOverflow.value = el.scrollHeight > el.clientHeight + 1;
    }

    // The <p> mounts/unmounts as descriptions come and go between clan swaps
    // on this reused instance — re-point the observer at each new element so
    // resize-driven re-measurement never watches a detached node. Observing
    // also delivers an initial callback, which covers the first measurement.
    const descResizeObserver = new ResizeObserver(measureDesc);
    watch(descEl, (el, old) => {
      if (old) descResizeObserver.unobserve(old);
      if (el) descResizeObserver.observe(el);
    });
    onBeforeUnmount(() => descResizeObserver.disconnect());

    /** Three-state cycle per column: desc → asc → back to role default. */
    function toggleSort(k: SortKey) {
      if (sortKey.value !== k) {
        sortKey.value = k;
        sortDir.value = "desc";
      } else if (sortDir.value === "desc") {
        sortDir.value = "asc";
      } else {
        sortKey.value = null;
        sortDir.value = "desc";
      }
    }

    const members = computed(() => {
      const list = [...props.clan.members];
      if (sortKey.value == null) {
        list.sort(
          (a, b) =>
            roleRank(a.role) - roleRank(b.role) ||
            (b.stats.battles ?? 0) - (a.stats.battles ?? 0),
        );
      } else {
        const k = sortKey.value;
        const d = sortDir.value === "desc" ? -1 : 1;
        list.sort((a, b) => {
          // Hidden members AND missing sort values sink in BOTH directions
          // (a fixed -Infinity would float them in asc order), then the key
          // decides; officers break ties.
          const byHidden = Number(a.stats.hidden) - Number(b.stats.hidden);
          if (byHidden !== 0) return byHidden;
          const va = sortValue(a, k);
          const vb = sortValue(b, k);
          const byMissing =
            Number(va === Number.NEGATIVE_INFINITY) - Number(vb === Number.NEGATIVE_INFINITY);
          if (byMissing !== 0) return byMissing;
          return d * (va - vb) || roleRank(a.role) - roleRank(b.role);
        });
      }
      return list;
    });

    // Sorting is per-clan viewing state: reset it when a different clan is
    // loaded into this reused component instance.
    watch(
      () => props.clan.clanId,
      () => {
        sortKey.value = null;
        sortDir.value = "desc";
        // Same for the description collapse — start collapsed, re-measure
        // after the new text renders.
        descExpanded.value = false;
        nextTick(measureDesc);
      },
    );

    const avgPrTier = computed(() => prTier(props.clan.avgPr ?? null));

    const kpis = computed(() => [
      {
        label: t("lookup.membersCount"),
        value: props.clan.membersCount.toLocaleString(),
      },
      {
        label: t("stats.avgDamage"),
        value: props.clan.avgDamage > 0 ? Math.round(props.clan.avgDamage).toLocaleString() : "—",
      },
      {
        label: t("stats.hidden"),
        value: props.clan.hiddenCount > 0 ? props.clan.hiddenCount.toLocaleString() : "0",
      },
      {
        label: t("lookup.createdAt"),
        value: props.clan.createdAt
          ? new Date(props.clan.createdAt * 1000).toLocaleDateString()
          : "—",
      },
    ]);

    /** Sortable column-header cell (label + direction arrow when active). */
    const headCell = (key: SortKey, label: string) => (
      <button
        type="button"
        class={[
          "clan-card__col",
          "clan-card__col--num",
          "clan-card__sort",
          sortKey.value === key ? "clan-card__sort--on" : "",
        ]}
        onClick={() => toggleSort(key)}
      >
        {label}
        {sortKey.value === key ? (
          sortDir.value === "desc" ? (
            <ArrowDown size={10} />
          ) : (
            <ArrowUp size={10} />
          )
        ) : null}
      </button>
    );

    return () => (
      <div class="clan-card">
        {/* identity header — same shared strip as the player card */}
        <IdentityHead
          name={props.clan.name}
          tag={props.clan.tag}
          v-slots={{
            badges: () => (
              <HTag variant="default" size="sm">{props.clan.realm.toUpperCase()}</HTag>
            ),
          }}
        />
        {props.clan.description ? (
          <>
            <p
              ref={descEl}
              class={[
                "clan-card__desc",
                descExpanded.value ? "" : "clan-card__desc--clamped",
              ]}
            >
              {props.clan.description}
            </p>
            {descOverflow.value ? (
              <button
                type="button"
                class="clan-card__desc-toggle"
                aria-expanded={descExpanded.value}
                onClick={() => {
                  descExpanded.value = !descExpanded.value;
                }}
              >
                {descExpanded.value ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {t(descExpanded.value ? "lookup.descCollapse" : "lookup.descExpand")}
              </button>
            ) : null}
          </>
        ) : null}

        <div class="clan-card__hero">
          <div class="clan-card__hero-main">
            <span
              class="clan-card__wr"
              style={{ color: winrateColor(props.clan.winrate) }}
            >
              {props.clan.winrate > 0 ? `${props.clan.winrate.toFixed(1)}%` : "—"}
            </span>
            <span class="clan-card__wr-label">{t("stats.winrate")}</span>
            <span class="clan-card__battles-total">
              {props.clan.totalBattles > 0
                ? `${props.clan.totalBattles.toLocaleString()} ${t("stats.battles")}`
                : "—"}
            </span>
          </div>
          {/* Average member PR — same tier scale/color as the player card. */}
          <div class="clan-card__pr-block" style={{ color: avgPrTier.value.color }}>
            <span class="clan-card__pr-num">
              {props.clan.avgPr != null ? props.clan.avgPr.toLocaleString() : "—"}
            </span>
            <span class="clan-card__pr-label">{avgPrTier.value.label}</span>
          </div>
        </div>

        <div class="clan-card__kpis">
          {kpis.value.map((k) => (
            <div class="clan-card__kpi" key={k.label}>
              <span class="clan-card__kpi-label">{k.label}</span>
              <span class="clan-card__kpi-value">{k.value}</span>
            </div>
          ))}
        </div>

        <div class="clan-card__roster">
          <div class="clan-card__roster-title">{t("lookup.clanMembers")}</div>
          <div class="clan-card__roster-head">
            <span class="clan-card__col clan-card__col--name">{t("lookup.memberName")}</span>
            <span class="clan-card__col clan-card__col--role">{t("lookup.roleLabel")}</span>
            {headCell("battles", t("stats.battles"))}
            {headCell("winrate", t("stats.winrate"))}
            {headCell("pr", t("stats.pr"))}
            {headCell("avgDamage", t("stats.avgDamage"))}
          </div>
          {members.value.map((m) => (
            <button
              key={m.accountId}
              type="button"
              class={[
                "clan-card__member",
                m.stats.hidden ? "clan-card__member--hidden" : "",
              ]}
              onClick={() => props.onMemberClick?.(m)}
              title={
                props.onMemberClick
                  ? `${t("account.nickname")}: ${m.name}`
                  : undefined
              }
            >
              <span class="clan-card__col clan-card__col--name">{m.name}</span>
              <span class="clan-card__col clan-card__col--role">{roleLabel(m.role)}</span>
              <span class="clan-card__col clan-card__col--num">
                {m.stats.battles != null ? m.stats.battles.toLocaleString() : "—"}
              </span>
              <span
                class="clan-card__col clan-card__col--num"
                style={
                  m.stats.winrate != null
                    ? { color: winrateColor(m.stats.winrate), fontWeight: 600 }
                    : undefined
                }
              >
                {m.stats.winrate != null ? `${m.stats.winrate.toFixed(1)}%` : "—"}
              </span>
              <span
                class="clan-card__col clan-card__col--num"
                style={
                  m.stats.pr != null
                    ? { color: prTier(m.stats.pr).color, fontWeight: 600 }
                    : undefined
                }
              >
                {m.stats.pr != null ? m.stats.pr.toLocaleString() : "—"}
              </span>
              <span class="clan-card__col clan-card__col--num">
                {m.stats.avgDamage != null
                  ? Math.round(m.stats.avgDamage).toLocaleString()
                  : "—"}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  },
});
