/* ------------------------------------------------------------------
   Barakah Essentials store settings.
   This is the ONLY file you edit to connect the store to your database.
   Steps are in SETUP.md. The Firebase web config below is meant to be
   public (it is not a secret) — your data is protected by firestore.rules.
------------------------------------------------------------------- */
window.STORE_CONFIG = {
  firebase: {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    appId: "YOUR_APP_ID"
  },
  currency: "Le",                    // shown before every price
  whatsappLink: "https://rb.gy/5b6zuz",
  defaultCountryCode: "232",         // used to build WhatsApp links to customers
  lowStockThreshold: 5               // "Only N left" appears at or below this
};
