<template>
  <nav class="drawer-side z-20">
    <label for="page-drawer" class="drawer-overlay"></label>
    <ul tabindex="0" class="menu min-h-full w-80 bg-light-green p-4">
      <li>
        <NuxtLinkLocale to="/" class="text-md btn btn-ghost normal-case text-black" @click="closeDrawer">
          {{ t("home.nav_label") }}
        </NuxtLinkLocale>
      </li>
      <li>
        <NuxtLinkLocale to="/municipalities" class="text-md btn btn-ghost normal-case text-black" @click="closeDrawer">
          {{ t("municipalities.nav_label") }}
        </NuxtLinkLocale>
      </li>
      <li>
        <NuxtLinkLocale to="/measures" class="text-md btn btn-ghost normal-case text-black" @click="closeDrawer">
          {{ t("measures.nav_label") }}
        </NuxtLinkLocale>
      </li>
      <li v-for="page in pages" :key="page.id">
        <NuxtLinkLocale :to="'/' + page.slug" class="text-md btn btn-ghost normal-case text-black" @click="closeDrawer">
          {{ page.name }}
        </NuxtLinkLocale>
      </li>
      <li>
        <a :href="backendUrl" class="text-md btn btn-ghost normal-case text-black" @click="closeDrawer"> Login </a>
      </li>
    </ul>
  </nav>
</template>
<script setup>
import { defineProps } from "vue";

const { t } = useI18n();
const props = defineProps(["pages"]);

const backendUrl = ref("#");

onMounted(() => {
  try {
    const protocol = window.location.protocol;
    backendUrl.value = `${protocol}//backend.` + window.location.host;
  } catch (error) {
    console.error("Error preparing backend URL:", error);
  }
});

function closeDrawer() {
  document.getElementById("page-drawer-toggle").click();
}
</script>
<style></style>
