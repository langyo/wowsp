## Summary / 概述
<!-- Brief description of changes / 变更简述 -->


## Title / 标题格式
<!-- The PR title becomes the squash subject and must follow AGENTS.md §1:
     `<gitmoji> <One English sentence ending with a period.>`
     No `type:` prefixes and no `Topic phrase:` colon shapes.
     Bot PRs (dependabot etc.) are exempt. -->
- [ ] 标题符合 `<gitmoji> <英文一句话.>` / Title follows the gitmoji rule

## Checklist / 自检清单
<!-- Before requesting review / 请求复查前请确认 -->
- [ ] `just lint` passes / 通过
- [ ] `just test unit` passes / 通过
- [ ] i18n keys added for both `en` and `zhs` if adding UI strings / 如有新增 UI 字符串，已同时添加中英文 key
- [ ] No secrets, real credentials, or private IPs in the diff / 无真实凭据与内网 IP（AGENTS.md §7 红线）
- [ ] Version fields bumped together if this changes the release version / 版本号六处同步（`scripts/check_versions.py`）

## Related Issues / 关联 Issue
<!-- e.g. Closes #123 -->
