# Barakah Essentials store — setup (about 20 minutes, free)

Until you finish this, the Barakah page shows your 8 products with "Order on WhatsApp"
buttons (no prices, no stock). After setup it becomes a live store.

## What you get
- **Customers**: browse products with price, discount, and items left; add to cart; place an order.
  No payment happens on the site — you contact them and they pay you directly.
- **You** (`admin.html`): add/edit/hide/delete products, set price, discount %, and items available,
  upload a photo, see every order, message the customer on WhatsApp, and mark orders
  Pending / Confirmed / Delivered / Cancelled.
- **Stock updates automatically**: each order lowers "items available". Cancelling an order puts
  the items back. Two people can't buy the last item at the same time.

## 1. Create the database (Firebase, free "Spark" plan)
1. Go to https://console.firebase.google.com → **Add project** → name it (e.g. `barakah-essentials`). Turn Google Analytics off.
2. **Build → Firestore Database → Create database** → choose a location near you → start in **production mode**.
3. **Build → Authentication → Get started → Email/Password → Enable**.
4. Authentication → **Users → Add user** → your email and a strong password. This is your admin login.
5. Project settings (gear icon) → **Your apps → Web (</>)** → register an app → copy the `firebaseConfig` values.

## 2. Connect the site
1. Open `store-config.js` and paste your values for `apiKey`, `authDomain`, `projectId`, `appId`.
   (This config is designed to be public — it is not a password.)
2. Set `currency` to what you want shown before prices (default `Le`).
3. Open `firestore.rules`, replace `OWNER_EMAIL@example.com` with the admin email from step 1.4.
4. Firebase console → Firestore → **Rules** → paste the whole file → **Publish**.
   These rules are what stop customers from changing prices or stock — don't skip this.

## 3. Put the site online (required)
The store needs to run from a real web address; it will not work by opening files from your phone's
downloads folder. Free options: **Firebase Hosting**, **Netlify** (drag the folder onto netlify.com/drop),
or **GitHub Pages**. Upload all the files together (all `.html` files, `store-config.js`).

If you use Netlify/GitHub Pages: Firebase console → Authentication → Settings → **Authorized domains**
→ add your site's domain so admin login works.

## 4. Add your products
1. Open `https://your-site/admin.html` and log in.
2. Click **Add starter products** to load your 8 existing items as hidden drafts, then for each:
   Edit → set price, discount (optional), items available, photo → Save → Show.
   Or add new products with **Add a product**.
3. Open the Barakah page — products appear live, with stock counts.

## Day to day
- **New order** → Orders tab (a badge shows pending ones). Click *Message customer on WhatsApp*,
  confirm, collect payment yourself, then set the status.
- **Restock**: change the number in the "Items available" box in the products table — it saves instantly.
- **Stop selling something**: click *Hide* (keeps it, removes it from the shop). *Delete* is permanent.
- Keep the admin web address private. Anyone can *see* the login page; only your account can get in.

## Good to know
- Free plan limits are generous for a small shop (about 50,000 reads / 20,000 writes a day).
- Prices in an order are recorded when the customer orders. Because payment happens off the site,
  you confirm the amount with the customer before they pay.
- Photos are stored inside the product record (resized to ~600px) so you don't need extra storage setup.
