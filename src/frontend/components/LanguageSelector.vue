<template>
  <div class="absolute right-20 top-0 inline-block w-24">
    <button
      class="hover:bg-gray-100 relative z-10 flex h-12 w-full items-center justify-between rounded-t-none border-none bg-light-green p-2 transition-all duration-300"
      :class="dropdownOpen ? 'rounded-b-none shadow-none' : 'rounded-b-md shadow-lg'"
      @click="toggleDropdown"
    >
      <div class="flex items-center space-x-2">
        <img :src="currentFlag" :alt="currentLanguage" class="h-4 w-6 rounded" />
        <span class="font-medium text-white">{{ currentLanguage }}</span>
      </div>
      <FontAwesomeIcon
        :icon="['fas', 'chevron-down']"
        class="h-4 w-4 text-white transition-transform duration-300"
        :class="{ 'rotate-180': dropdownOpen }"
      />
    </button>
    <transition name="fade-slide">
      <div
        v-if="dropdownOpen"
        class="absolute left-0 top-full z-0 w-full overflow-hidden rounded-b-md rounded-t-none border-none bg-light-green shadow-lg"
      >
        <div
          v-for="lang in availableLanguages"
          :key="lang.code"
          class="hover:bg-gray-100 flex cursor-pointer items-center space-x-2 p-2 text-white"
          @click="switchLanguage(lang)"
        >
          <img :src="lang.flag" :alt="lang.code" class="h-4 w-6 rounded" />
          <label class="font-medium">{{ lang.code }}</label>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, computed } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import {fetchAndApplyTranslations} from "#shared/loadTranslations";

export default {
  components: { FontAwesomeIcon },
  async setup() {
    const { $directus, $readItems, $i18n } = useNuxtApp();
    const { locale, locales, setLocale, mergeLocaleMessage } = useI18n();

    const { data: fetchedLanguages } = await useAsyncData("fetchedLanguages", () => {
      return $directus.request(
        $readItems("languages", {
          limit: -1,
        }),
      );
    });

    const languages = computed(() => {
      return fetchedLanguages.value.map((language) => {
        const parts = language.code.split("-");
        const languageCode = parts[0].toUpperCase();
        const countryCode = parts[1].toLowerCase();
        return {
          code: languageCode,
          flag: `https://flagcdn.com/w40/${countryCode}.png`,
          iso: language.code,
        };
      });
    });

    const currentLanguage = ref(locale.value.split("-")[0].toUpperCase());
    const currentFlag = ref(
      languages.value.find((lang) => lang.code === locale.value.split("-")[0].toUpperCase()).flag,
    );
    const dropdownOpen = ref(false);

    const toggleDropdown = () => {
      dropdownOpen.value = !dropdownOpen.value;
    };

    const switchLanguage = async (lang) => {
      currentLanguage.value = lang.code;
      currentFlag.value = lang.flag;
      dropdownOpen.value = false;
      console.log("Switching to language: ", lang.iso);
      await setLocale(lang.iso);
      console.log("current locale: ", locale.value);
      await fetchAndApplyTranslations($i18n, $directus);
    };

    const availableLanguages = computed(() => {
      return languages.value.filter((lang) => lang.code !== currentLanguage.value);
    });

    return {
      languages,
      currentLanguage,
      currentFlag,
      dropdownOpen,
      toggleDropdown,
      switchLanguage,
      availableLanguages,
    };
  },
};
</script>

<style scoped>
button {
  transition:
    border-radius 0.3s ease-in-out,
    background-color 0.3s ease-in-out;
}

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition:
    transform 0.3s ease-in-out,
    opacity 0.3s ease-in-out;
}

.fade-slide-enter-from,
.fade-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
