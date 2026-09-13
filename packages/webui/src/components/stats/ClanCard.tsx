/**
 * ClanCard — clan overview card, the clan-mode counterpart of StatsCard:
 *   ┌─ identity: [TAG] name + realm ─
 *   ├─ hero: clan-wide aggregate winrate + total battles
 *   ├─ KPI grid: members / avg damage / hidden profiles / created
 *   └─ roster table: name (→ player lookup) / role / battles / WR / avg dmg
 *
 * Aggregates come precomputed from the backend (visible members only).
 */
import { computed, defineComponent, type PropType } from "vue";

import { HTag } from "@celestia-island/hikari";

import type { ClanInfo, ClanMember } from "@/api";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
import "./ClanCard.scss";

/** Roster sort: clan officers first, then by battles desc. */
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

function roleLabel(role: string): string {
  const key = `lookup.role.${role}`;
  const label = t(key);
  // vue-i18n returns the key itself for missing entries — fall back to the
  // raw WG role string.
  return label === key ? role : label;
}

export default defineComponent({
  name: "ClanCard",
  props: {
    clan: { type: Object as () => ClanInfo, required: true },
    /** Roster row clicked → jump to that player's lookup. */
    onMemberClick: Function as PropType<(member: ClanMember) => void>,
  },
  setup(props) {
    const members = computed(() => {
      const roleRank = (r: string) => {
        const i = ROLE_ORDER.indexOf(r);
        return i === -1 ? ROLE_ORDER.length : i;
      };
      return [...props.clan.members].sort((a, b) => {
        const byRole = roleRank(a.role) - roleRank(b.role);
        if (byRole !== 0) return byRole;
        return (b.stats.battles ?? 0) - (a.stats.battles ?? 0);
      });
    });

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

    return () => (
      <div class="clan-card">
        <header class="clan-card__head">
          <div class="clan-card__name-line">
            <span class="clan-card__tag">[{props.clan.tag}]</span>
            <h3 class="clan-card__name">{props.clan.name}</h3>
          </div>
          <div class="clan-card__badges">
            <HTag variant="default" size="sm">{props.clan.realm.toUpperCase()}</HTag>
          </div>
        </header>
        {props.clan.description ? (
          <p class="clan-card__desc">{props.clan.description}</p>
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
            <span class="clan-card__col clan-card__col--num">{t("stats.battles")}</span>
            <span class="clan-card__col clan-card__col--num">{t("stats.winrate")}</span>
            <span class="clan-card__col clan-card__col--num">{t("stats.avgDamage")}</span>
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
