/** Minimal toast shim (ai-chatbot uses sonner). */
export const toast = {
  success(message: string) {
    console.info("[jMovie]", message);
  },
  error(message: string) {
    console.error("[jMovie]", message);
  },
};
