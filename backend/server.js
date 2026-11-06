
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

dotenv.config();

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Origin not allowed by CORS"));
    }
}));

app.use(express.json({ limit: "100kb" }));

// Firebase Admin connection
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  const localAccount = await import("./serviceAccountKey.json", {
    with: { type: "json" }
  });

  serviceAccount = localAccount.default;
}

initializeApp({
  credential: cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = getFirestore();

// Firebase Authentication and administrator verification
const firebaseAuth = getAuth();

async function requireAdmin(req, res, next) {
    const header = req.get("authorization") || "";

    if (!header.toLowerCase().startsWith("bearer ")) {
        return res.status(401).json({
            success: false,
            error: "Authentication token required."
        });
    }

    const idToken = header.slice(7).trim();

    if (!idToken) {
        return res.status(401).json({
            success: false,
            error: "Authentication token required."
        });
    }

    try {
        const decoded = await firebaseAuth.verifyIdToken(idToken);

        const email = String(decoded.email || "").trim().toLowerCase();

        const allowedEmails = (process.env.ADMIN_EMAILS || "")
            .split(",")
            .map(value => value.trim().toLowerCase())
            .filter(Boolean);

        if (
    !email ||
    decoded.email_verified !== true ||
    !allowedEmails.includes(email)
) {
            return res.status(403).json({
                success: false,
                error: "Administrator access denied."
            });
        }

        req.admin = {
            uid: decoded.uid,
            email
        };

        next();

    } catch (error) {
        console.warn("Admin authentication failed:", error.code || "invalid-token");

        return res.status(401).json({
            success: false,
            error: "Invalid or expired authentication token."
        });
    }
}

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        message: "Inscribe Hub backend is running"
    });
});

// Firebase connection test
app.get("/firebase-test", async (req, res) => {
    try {
        await db.collection("products").limit(1).get();

        res.json({
            status: "OK",
            message: "Firebase connection successful"
        });
    } catch (error) {
        console.error("Firebase test failed:", error.message);

        res.status(500).json({
            status: "ERROR",
            message: "Firebase connection failed"
        });
    }
});

// Read-only product test
app.get("/firebase-product-test/:id", async (req, res) => {
  try {
    const snap = await db
      .collection("products")
      .doc(req.params.id)
      .get();

    if (!snap.exists) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    const p = snap.data();
    const price = Number(p.price);
    const discount = Math.min(
      100,
      Math.max(0, Number(p.discount) || 0)
    );

    res.json({
      name: p.name,
      active: p.active,
      originalPrice: price,
      discount: discount,
      finalPrice: Math.round(price * (1 - discount / 100)),
      stock: p.stock
    });

  } catch (error) {
    console.error("Product test failed:", error.message);

    res.status(500).json({
      error: "Product test failed"
    });
  }
});

// Secure order endpoint
app.post("/api/orders", async (req, res) => {
    try {
        const { customer, items } = req.body;

        if (
            !customer ||
            typeof customer.name !== "string" ||
            customer.name.trim().length < 2 ||
            typeof customer.phone !== "string" ||
            customer.phone.replace(/\D/g, "").length < 6 ||
            !Array.isArray(items) ||
            items.length === 0 ||
            items.length > 30
        ) {
            return res.status(400).json({
                error: "Invalid customer details or order items."
            });
        }

        const quantities = new Map();

        for (const item of items) {
            if (
                !item ||
                typeof item.id !== "string" ||
                !Number.isSafeInteger(item.qty) ||
                item.qty < 1 ||
                item.qty > 100
            ) {
                return res.status(400).json({
                    error: "Invalid product or quantity."
                });
            }

            quantities.set(
                item.id,
                (quantities.get(item.id) || 0) + item.qty
            );
        }

        if ([...quantities.values()].some(qty => qty > 100)) {
            return res.status(400).json({
                error: "Requested quantity is too high."
            });
        }

        const orderRef = db.collection("orders").doc();

        const result = await db.runTransaction(async tx => {
            const productRefs = [...quantities.keys()].map(id =>
                db.collection("products").doc(id)
            );

            const snapshots = await Promise.all(
                productRefs.map(ref => tx.get(ref))
            );

            const lines = [];
            const updates = [];
            let total = 0;

            snapshots.forEach((snap, index) => {
                if (!snap.exists) {
                    throw new Error("UNAVAILABLE:An item");
                }

                const product = snap.data();
                const productId = productRefs[index].id;
                const qty = quantities.get(productId);

                if (product.active !== true) {
                    throw new Error("UNAVAILABLE:" + product.name);
                }

                const stock = Number(product.stock) || 0;

                if (!Number.isSafeInteger(stock) || stock < qty) {
                    throw new Error(
                        `STOCK:${product.name}:${stock}:${productId}`
                    );
                }

                const price = Number(product.price);
                const discount = Number(product.discount) || 0;

                if (
                    !Number.isFinite(price) ||
                    price < 0 ||
                    !Number.isFinite(discount) ||
                    discount < 0 ||
                    discount > 100
                ) {
                    throw new Error("INVALID_PRICE");
                }

                const unitPrice = Math.round(
                    price * (1 - discount / 100)
                );

                total += unitPrice * qty;

                lines.push({
                    productId,
                    name: String(product.name || "Item"),
                    qty,
                    unitPrice,
                    listPrice: price,
                    discount
                });

                updates.push({
                    ref: snap.ref,
                    stock: stock - qty
                });
            });

            // All reads are complete before writes.
            updates.forEach(update => {
                tx.update(update.ref, { stock: update.stock });
            });

            tx.create(orderRef, {
                customerName: customer.name.trim(),
                phone: customer.phone.trim(),
                address: typeof customer.address === "string"
                    ? customer.address.trim().slice(0, 500)
                    : "",
                notes: typeof customer.notes === "string"
                    ? customer.notes.trim().slice(0, 1000)
                    : "",
                items: lines,
                total: Math.round(total * 100) / 100,
                status: "pending",
                createdAt: FieldValue.serverTimestamp()
            });

            return {
                orderId: orderRef.id,
                total: Math.round(total * 100) / 100
            };
        });

        return res.status(201).json({
            success: true,
            orderId: result.orderId,
            total: result.total
        });

    } catch (error) {
        console.error("Order error:", error.message);

        if (error.message.startsWith("STOCK:")) {
            const parts = error.message.split(":");

            return res.status(409).json({
                code: "STOCK",
                name: parts[1],
                available: Number(parts[2]) || 0,
                productId: parts[3]
            });
        }

        if (error.message.startsWith("UNAVAILABLE:")) {
            return res.status(409).json({
                code: "UNAVAILABLE",
                message: "One of the products is unavailable."
            });
        }

        if (error.message === "INVALID_PRICE") {
            return res.status(409).json({
                code: "INVALID_PRICE",
                message: "A product has an invalid price."
            });
        }

        return res.status(500).json({
            error: "We could not process your order."
        });
    }
});


// Public read-only Scholarship Hub API
app.get("/api/opportunities", async (req, res) => {
    try {
        const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
}).formatToParts(new Date());

const today = `${dateParts.find(p => p.type === "year").value}-${dateParts.find(p => p.type === "month").value}-${dateParts.find(p => p.type === "day").value}`;
        const archive = req.query.archive === "true";
        const requestedCategory = typeof req.query.category === "string"
            ? req.query.category.trim().toLowerCase()
            : "";

        const snapshot = await db.collection("opportunities").get();

        const opportunities = [];

        snapshot.forEach(doc => {
            const data = doc.data();

            // Only approved and published records are public.
            if (data.approved !== true || data.published !== true) {
                return;
            }

            const openingDate = data.openingDate;
            const deadline = data.deadline;

            // Both dates must be valid ISO date strings.
            const validDate = value => {
                if (typeof value !== "string" ||
                    !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    return false;
                }

                const [year, month, day] = value.split("-").map(Number);
                const date = new Date(Date.UTC(year, month - 1, day));

                return date.getUTCFullYear() === year &&
                    date.getUTCMonth() === month - 1 &&
                    date.getUTCDate() === day;
            };

            if (!validDate(openingDate) || !validDate(deadline)) {
                return;
            }

            let status;

            if (deadline < today) {
                status = "closed";
            } else if (openingDate > today) {
                const daysUntilOpening = Math.ceil(
                    (Date.parse(openingDate + "T00:00:00.000Z") -
                     Date.parse(today + "T00:00:00.000Z")) /
                    86400000
                );

                if (daysUntilOpening > 30) return;

                status = "upcoming";
            } else {
                status = "open";
            }

            // Closed records are available only through the archive.
            if (status === "closed" && !archive) return;
            if (status !== "closed" && archive) return;

            if (
                requestedCategory &&
                String(data.category || "").toLowerCase() !== requestedCategory
            ) {
                return;
            }

            // Return only approved public information.
            const publicFields = [
                "name",
                "country",
                "region",
                "category",
                "levels",
                "field",
                "fields",
                "funding",
                "coverage",
                "fundingDetails",
                "criteria",
                "requirements",
                "eligibility",
                "nationalities",
                "note",
                "openingDate",
                "deadline",
                "link",
                "applicationUrl",
                "verifiedOn",
                "provider",
                "imageUrl",
                "sourceUrl"
            ];

            const record = {};

            for (const field of publicFields) {
                if (data[field] !== undefined) {
                    record[field] = data[field];
                }
            }

            record.id = doc.id;
            record.status = status;

            opportunities.push(record);
        });

        opportunities.sort((a, b) =>
            a.openingDate.localeCompare(b.openingDate)
        );

        return res.json({
            success: true,
            count: opportunities.length,
            asOf: today,
            upcomingWindowDays: 30,
            opportunities
        });

    } catch (error) {
        console.error("Opportunities API error:", error.message);

        return res.status(500).json({
            success: false,
            error: "Could not retrieve opportunities."
        });
    }
});


// Validate Firestore opportunity document IDs.
function validateOpportunityId(id) {
    return typeof id === "string" &&
        id.trim().length > 0 &&
        !id.includes("/");
}
// ---------- Protected Scholarship Management API ----------

const opportunityCategories = [
    "scholarship",
    "internship",
    "development_programme",
    "conference"
];

const opportunityFields = [
    "name", "country", "region", "category",
    "levels", "field", "fields", "funding",
    "coverage", "fundingDetails", "criteria",
    "requirements", "eligibility", "nationalities",
    "note", "openingDate", "deadline", "link",
    "applicationUrl", "verifiedOn", "provider",
    "imageUrl", "sourceUrl"
];

function validateOpportunity(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return "A valid opportunity object is required.";
    }

    const record = {};

    for (const field of opportunityFields) {
        if (body[field] !== undefined) {
            record[field] = body[field];
        }
    }

    if (typeof record.name !== "string" || !record.name.trim()) {
        return "Opportunity name is required.";
    }

    if (typeof record.country !== "string" || !record.country.trim()) {
        return "Country is required.";
    }

    if (!opportunityCategories.includes(record.category)) {
        return "Invalid opportunity category.";
    }

    const validDate = value => {
        if (typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }

        const [year, month, day] = value.split("-").map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));

        return date.getUTCFullYear() === year &&
            date.getUTCMonth() === month - 1 &&
            date.getUTCDate() === day;
    };

    if (!validDate(record.openingDate) || !validDate(record.deadline)) {
        return "Valid opening and deadline dates are required.";
    }

    if (record.deadline < record.openingDate) {
        return "Deadline cannot be earlier than opening date.";
    }

    if (record.verifiedOn !== undefined && !validDate(record.verifiedOn)) {
        return "Verification date must use YYYY-MM-DD.";
    }

    for (const field of ["link", "applicationUrl", "sourceUrl", "imageUrl"]) {
        if (record[field] !== undefined) {
            try {
                const url = new URL(record[field]);
                if (url.protocol !== "https:") throw new Error();
            } catch {
                return field + " must be a valid HTTPS URL.";
            }
        }
    }

    for (const field of [
        "levels", "fields", "coverage", "criteria",
        "requirements", "nationalities"
    ]) {
        if (record[field] !== undefined &&
            (!Array.isArray(record[field]) ||
             record[field].some(item => typeof item !== "string"))) {
            return field + " must be an array of text values.";
        }
    }

    for (const field of [
        "region", "field", "funding", "fundingDetails",
        "note", "eligibility", "provider"
    ]) {
        if (record[field] !== undefined &&
            typeof record[field] !== "string") {
            return field + " must be text.";
        }
    }

    record.name = record.name.trim();
    record.country = record.country.trim();

    return record;
}

// Create a new opportunity. New records are private by default.

// Retrieve all opportunities for authenticated administrators.
app.get("/api/admin/opportunities", requireAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection("opportunities").get();

        const opportunities = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        opportunities.sort((a, b) => {
            const dateA = a.updatedAt?.toMillis?.() || 0;
            const dateB = b.updatedAt?.toMillis?.() || 0;
            return dateB - dateA;
        });

        return res.json({
            success: true,
            count: opportunities.length,
            opportunities
        });
    } catch (error) {
        console.error("Admin opportunities list error:", error.message);
        return res.status(500).json({
            success: false,
            error: "Could not retrieve opportunities."
        });
    }
});
app.post("/api/admin/opportunities", requireAdmin, async (req, res) => {
    try {
        const record = validateOpportunity(req.body);

        if (typeof record === "string") {
            return res.status(400).json({ success: false, error: record });
        }

        const doc = await db.collection("opportunities").add({
            ...record,
            approved: false,
            published: false,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            createdBy: req.admin.uid
        });

        return res.status(201).json({
            success: true,
            id: doc.id,
            message: "Opportunity created. It is awaiting approval."
        });
    } catch (error) {
        console.error("Create opportunity error:", error.message);
        return res.status(500).json({
            success: false,
            error: "Could not create opportunity."
        });
    }
});

// Edit an existing opportunity.
app.put("/api/admin/opportunities/:id", requireAdmin, async (req, res) => {
    try {
        const record = validateOpportunity(req.body);

        if (typeof record === "string") {
            return res.status(400).json({ success: false, error: record });
        }

        if (!validateOpportunityId(req.params.id)) {
            return res.status(400).json({
                success: false,
                error: "Invalid opportunity ID."
            });
        }

        const ref = db.collection("opportunities").doc(req.params.id);
        const existing = await ref.get();

        if (!existing.exists) {
            return res.status(404).json({
                success: false,
                error: "Opportunity not found."
            });
        }

        await ref.update({
            ...record,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: req.admin.uid
        });

        return res.json({
            success: true,
            message: "Opportunity updated."
        });
    } catch (error) {
        console.error("Update opportunity error:", error.message);
        return res.status(500).json({
            success: false,
            error: "Could not update opportunity."
        });
    }
});

// Approve or reject an opportunity.
app.patch("/api/admin/opportunities/:id/review", requireAdmin, async (req, res) => {
    try {
        if (typeof req.body.approved !== "boolean") {
            return res.status(400).json({
                success: false,
                error: "approved must be true or false."
            });
        }

        if (!validateOpportunityId(req.params.id)) {
            return res.status(400).json({
                success: false,
                error: "Invalid opportunity ID."
            });
        }

        const ref = db.collection("opportunities").doc(req.params.id);
        const existing = await ref.get();

        if (!existing.exists) {
            return res.status(404).json({
                success: false,
                error: "Opportunity not found."
            });
        }

        await ref.update({
            approved: req.body.approved,
            published: req.body.approved ? existing.data().published === true : false,
            updatedAt: FieldValue.serverTimestamp(),
            reviewedBy: req.admin.uid,
            reviewedAt: FieldValue.serverTimestamp()
        });

        return res.json({
            success: true,
            approved: req.body.approved
        });
    } catch (error) {
        console.error("Review opportunity error:", error.message);
        return res.status(500).json({
            success: false,
            error: "Could not review opportunity."
        });
    }
});

// Publish or unpublish an approved opportunity.
app.patch("/api/admin/opportunities/:id/publication", requireAdmin, async (req, res) => {
    try {
        if (typeof req.body.published !== "boolean") {
            return res.status(400).json({
                success: false,
                error: "published must be true or false."
            });
        }

        if (!validateOpportunityId(req.params.id)) {
            return res.status(400).json({
                success: false,
                error: "Invalid opportunity ID."
            });
        }

        const ref = db.collection("opportunities").doc(req.params.id);
        const existing = await ref.get();

        if (!existing.exists) {
            return res.status(404).json({
                success: false,
                error: "Opportunity not found."
            });
        }

        if (req.body.published && existing.data().approved !== true) {
            return res.status(403).json({
                success: false,
                error: "An opportunity must be approved before publication."
            });
        }

        await ref.update({
            published: req.body.published,
            updatedAt: FieldValue.serverTimestamp(),
            publishedBy: req.admin.uid,
            ...(req.body.published
                ? { publishedAt: FieldValue.serverTimestamp() }
                : { unpublishedAt: FieldValue.serverTimestamp() })
        });

        return res.json({
            success: true,
            published: req.body.published
        });
    } catch (error) {
        console.error("Publish opportunity error:", error.message);
        return res.status(500).json({
            success: false,
            error: "Could not update publication status."
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Inscribe Hub API running on port ${PORT}`);
});
