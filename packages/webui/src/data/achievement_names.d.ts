declare module "*/achievement_names.json" {
  const achievementNames: Record<
    string,
    { key: string; type: string; names: Partial<Record<string, string>> }
  >;
  export default achievementNames;
}
