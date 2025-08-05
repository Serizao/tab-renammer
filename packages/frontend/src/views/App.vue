<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { ref } from "vue";

const myVar = ref("Hello World");

// Generate a random string
const onGenerateClick = async () => {
  const randomString = Math.random().toString(36).substring(2, 12);
  myVar.value = randomString;
};
</script>

<template>
  <div class="h-full flex justify-center items-center">
    <div class="flex flex-col gap-1">
      <Button label="Generate random string" @click="onGenerateClick" />
      <InputText :model-value="myVar" readonly />
    </div>
  </div>
</template>
