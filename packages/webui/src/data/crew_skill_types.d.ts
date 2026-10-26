/**
 * Generated asset declaration (scripts/extract_gameparam_ids.py).
 *
 * Captain-skill "skillType" ordinal -> GameParams skill code plus the
 * per-class tier row (the tier IS the point cost, 1..4). Declared explicitly
 * so tsc never infers the literal type from the JSON.
 *
 * The exact specifier form is used for the same reason as gameparam_ids.d.ts
 * (a wildcard module declaration does not shadow a paths-aliased JSON import
 * under this repo's TypeScript).
 */
declare module "@/data/crew_skill_types.json" {
  const crewSkillTypes: Record<
    string,
    { code: string; tier: Partial<Record<string, number>> }
  >;
  export default crewSkillTypes;
}
