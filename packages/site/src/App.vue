<script setup lang="ts">
const features = [
  {
    title: "Replay Review",
    desc: "Open any .wowsreplay and watch the full match on a holographic 3D map — no game launch required.",
  },
  {
    title: "3D Ship Viewer",
    desc: "Browse every ship in the game as a low-poly holographic model. Rotate, zoom, inspect armor layouts.",
  },
  {
    title: "In-Game Overlay",
    desc: "A transparent overlay shows live team rosters while you play, visible only when you hold Tab.",
  },
  {
    title: "Stats & Insights",
    desc: "Deep-dive into your battle history with per-ship stats, ranked seasons, and performance trends.",
  },
];

const links = [
  { label: "GitHub", href: "https://github.com/langyo/wowsp" },
  { label: "Documentation", href: "/docs" },
];
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 py-16">
    <img src="/logo.webp" alt="WoWSP" class="w-32 h-32 mb-6" />

    <h1 class="text-4xl font-bold mb-2">WoWSP</h1>
    <p class="text-lg text-[#8ea8cc] mb-12">
      World of WarShip Panel — replay review &amp; in-game overlay
    </p>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl w-full mb-12">
      <div
        v-for="f in features"
        :key="f.title"
        class="bg-[#131e32] border border-[#1e3250] rounded-xl p-5"
      >
        <h3 class="text-sm font-semibold mb-2 text-[#7aa2f7]">{{ f.title }}</h3>
        <p class="text-sm leading-relaxed text-[#a0b8d4]">{{ f.desc }}</p>
      </div>
    </div>

    <div class="flex gap-4">
      <a
        v-for="l in links"
        :key="l.href"
        :href="l.href"
        class="px-5 py-2 rounded-lg bg-[#1e3250] hover:bg-[#2a4570] text-sm transition-colors no-underline text-[#cfe3ff]"
      >
        {{ l.label }}
      </a>
    </div>

    <p class="mt-16 text-xs text-[#587898]">
      Licensed under SySL-1.0 &middot; Built by
      <a href="https://github.com/langyo" class="text-[#7aa2f7] hover:underline">langyo</a>
    </p>
  </div>
</template>
