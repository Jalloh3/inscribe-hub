
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

dotenv.config();

const app = express();

app.use(cors({
    origin: process.env.FRONTEND_URL
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

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Inscribe Hub API running on port ${PORT}`);
});
