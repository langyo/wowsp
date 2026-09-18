# Bundled stamp font

`WowspStamp-Regular.ttf` is a **4-glyph subset** (神 了 海 猴) of
[Zhuque Fangsong](https://github.com/TrionesType/zhuque) v0.212
(朱雀仿宋), used only by the `RatingStamp` seal component. The family has
been renamed from "Zhuque Fangsong" to "Wowsp Stamp" for the subset build.

## Why bundled

The stamp must look identical across platforms, and no freely licensed
方正姚体 (FZYaoti) lookalike exists that we may redistribute — Zhuque
Fangsong is the closest verbatim-OFL art-song style, which shares 姚体's
print-serif construction.

## License

Distributed under the [SIL Open Font License 1.1](./LICENSE-OFL.txt)
(copyright Zhejiang JadeFoci Technology Co. LTD). OFL permits bundling,
subsetting and renaming; the license text must accompany the font, hence
this directory.

## Rebuilding the subset

```sh
pyftsubset ZhuqueFangsong-Regular.ttf \
  --output-file=stamp-subset.ttf \
  --text="神了海猴" \
  --layout-features='*' --glyph-names --recalc-bounds --notdef-outline
# then rename name IDs 1/3/4/6/16/17 to "Wowsp Stamp" / WowspStamp-Regular
```
