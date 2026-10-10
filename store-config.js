/* ------------------------------------------------------------------
   Barakah Essentials store settings.
   This is the ONLY file you edit to connect the store to your database.
   Steps are in SETUP.md. The Firebase web config below is meant to be
   public (it is not a secret) — your data is protected by firestore.rules.
------------------------------------------------------------------- */
window.STORE_CONFIG = {
  firebase: {
    apiKey: "AIzaSyDQHEaxSsOcmMeJvwx1eMK46XYxPTn5Wq4",
    authDomain: "barakah-essentials.firebaseapp.com",
    projectId: "barakah-essentials",
    appId: "1:389337576778:web:b2d31060604ae40d197db3"
  },
  currency: "Le",                    // shown before every price
  whatsappLink: "https://rb.gy/5b6zuz",
  defaultCountryCode: "232",         // used to build WhatsApp links to customers
  lowStockThreshold: 5               // "Only N left" appears at or below this
};
