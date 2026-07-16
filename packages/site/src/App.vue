<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t, locale } = useI18n();

const locales = [
  { code: "en", label: "English" },
  { code: "zhs", label: "简体中文" },
] as const;

function switchLocale(code: string) {
  locale.value = code;
  try {
    localStorage.setItem("wowsp-site-locale", code);
  } catch {}
}

const featureKeys = ["replay", "viewer", "overlay", "stats"] as const;

const links = [
  { key: "github", href: "https://github.com/langyo/wowsp" },
  { key: "docs", href: "/docs" },
] as const;
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 py-16">
    <img src="/logo.webp" alt="WoWSP" class="w-32 h-32 mb-6" />

    <h1 class="text-4xl font-bold mb-2">{{ t("title") }}</h1>
    <p class="text-lg text-[#8ea8cc] mb-8">{{ t("tagline") }}</p>

    <div class="flex gap-2 mb-12">
      <button
        v-for="l in locales"
        :key="l.code"
        @click="switchLocale(l.code)"
        :class="[
          'px-3 py-1 rounded text-xs transition-colors',
          locale === l.code
            ? 'bg-[#7aa2f7] text-[#0b1220]'
            : 'bg-[#1e3250] hover:bg-[#2a4570] text-[#a0b8d4]',
        ]"
      >
        {{ l.label }}
      </button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl w-full mb-12">
      <div
        v-for="k in featureKeys"
        :key="k"
        class="bg-[#131e32] border border-[#1e3250] rounded-xl p-5"
      >
        <h3 class="text-sm font-semibold mb-2 text-[#7aa2f7]">
          {{ t(`features.${k}.title`) }}
        </h3>
        <p class="text-sm leading-relaxed text-[#a0b8d4]">
          {{ t(`features.${k}.desc`) }}
        </p>
      </div>
    </div>

    <div class="flex gap-4">
      <a
        v-for="l in links"
        :key="l.key"
        :href="l.href"
        class="px-5 py-2 rounded-lg bg-[#1e3250] hover:bg-[#2a4570] text-sm transition-colors no-underline text-[#cfe3ff]"
      >
        {{ t(`links.${l.key}`) }}
      </a>
    </div>

    <p class="mt-16 text-xs text-[#587898]">
      {{ t("footer") }} &middot;
      {{ t("links.github") }}
      <a href="https://github.com/langyo" class="text-[#7aa2f7] hover:underline">langyo</a>
    </p>
  </div>
</template>
